import type { Response } from "express";
import {
  CoreClientError as SvgTransformCoreClientError,
  createSvgTransformClient,
} from "@svg-transform/core-client";

import { getBackendConfig } from "../config/index.js";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /^(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|credentials?|password|secret|secret[-_]?key|client[-_]?secret|private[-_]?(?:key|token)|ssh[-_]?private[-_]?key|tokens?|(?:access|refresh|id|auth|api|github|gitlab|bearer)[-_]?token|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key|cookies?|set[-_]?cookie)$/i;

const SENSITIVE_TEXT_LABEL =
  String.raw`(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|credentials?|password|secret[-_]?key|client[-_]?secret|private[-_]?key|ssh[-_]?private[-_]?key|(?:access|refresh|auth|api|github|gitlab|bearer)[-_]?token|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key)`;
const QUOTED_SENSITIVE_VALUE = new RegExp(
  `(["']?${SENSITIVE_TEXT_LABEL}["']?\\s*:\\s*["'])[^"']*(["'])`,
  "gi",
);
const ASSIGNED_SENSITIVE_VALUE = new RegExp(
  String.raw`(${SENSITIVE_TEXT_LABEL}\s*[:=]\s*)(?:["'][^"'\n]*["']|Bearer\s+[A-Za-z0-9._~+/=-]+|(?!\\)[^\s,;}"'\n]+)`,
  "gi",
);
const TOKEN_ASSIGNMENT =
  /(\btoken\s*=\s*)(?:["'][^"'\n]*["']|(?!\\)[^\s,;}"'\n]+)/gi;

const redactSensitiveText = (value: string) =>
  value
    .replace(QUOTED_SENSITIVE_VALUE, `$1${REDACTED}$2`)
    .replace(ASSIGNED_SENSITIVE_VALUE, `$1${REDACTED}`)
    .replace(TOKEN_ASSIGNMENT, `$1${REDACTED}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g,
      REDACTED,
    );

const redactSensitiveData = (value: unknown, key = ""): unknown => {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
      entryKey,
      redactSensitiveData(entry, entryKey),
    ]),
  );
};

class CoreServiceError extends SvgTransformCoreClientError {
  constructor(message: string, status: number, payload?: unknown) {
    super(message, status, payload);
    this.name = "CoreServiceError";
  }
}

const getCoreServiceUrl = () => {
  const url = getBackendConfig().core.serviceUrl?.trim();
  if (!url) {
    throw new Error("SVG_TRANSFORM_CORE_URL is required for gateway mode");
  }
  return trimTrailingSlash(url);
};

const coreUrl = (path: string) => `${getCoreServiceUrl()}${path}`;

const getCoreClient = () =>
  createSvgTransformClient({
    baseUrl: getCoreServiceUrl(),
  });

const normalizeCoreError = (error: unknown) => {
  if (error instanceof SvgTransformCoreClientError) {
    if (error.status === 502 && error.payload === undefined && error.message.startsWith("Core service unavailable:")) {
      return new CoreServiceError("转换服务暂不可用，请稍后重试", 503);
    }
    return new CoreServiceError(error.message, error.status, error.payload);
  }
  return new CoreServiceError("转换服务暂不可用，请稍后重试", 503);
};

const requestCore = async (path: string, init?: RequestInit) => {
  try {
    return await getCoreClient().request(path, init);
  } catch (error) {
    throw normalizeCoreError(error);
  }
};

const requestCoreJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  try {
    return await getCoreClient().requestJson<T>(path, init);
  } catch (error) {
    throw normalizeCoreError(error);
  }
};

const assertCoreAvailable = async () => {
  const response = await requestCore("/health", {
    signal: AbortSignal.timeout(5_000),
  });
  const text = (await response.text()).trim();
  if (text !== "ok") {
    throw new CoreServiceError(`Core service health check returned: ${text || "(empty)"}`, 502);
  }
};

// Core may return absolute job paths like /app/workspace/jobs/<id>/Cover.html.
// Frontend /files APIs expect job-relative paths (Cover.html).
const toJobRelativePathText = (value: string) =>
  value.replace(
    /(?:file:\/\/)?\/app\/workspace\/jobs\/[^/\s"'`<>),\]}]+\/([^\s"'`<>),\]}]+)/g,
    "$1",
  );

const rewriteCoreUrlValue = (value: string, base: string) => {
  let rewritten = value;
  if (value.startsWith(`${base}/api/jobs`)) {
    rewritten = `/transformer${value.slice(base.length)}`;
  } else if (value.startsWith("/api/jobs")) {
    rewritten = `/transformer${value}`;
  }
  return toJobRelativePathText(rewritten);
};

const rewriteCoreUrls = (value: unknown, base = getCoreServiceUrl()): unknown => {
  if (typeof value === "string") {
    return rewriteCoreUrlValue(redactSensitiveText(value), base);
  }
  if (Array.isArray(value)) return value.map(entry => rewriteCoreUrls(entry, base));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
      SENSITIVE_KEY.test(key)
        ? [key, REDACTED]
        : [key, rewriteCoreUrls(entry, base)],
    ),
  );
};

const rewriteCoreTextValue = (value: string) => {
  const base = getCoreServiceUrl();
  return toJobRelativePathText(
    redactSensitiveText(value)
      .split(`${base}/api/jobs`)
      .join("/transformer/api/jobs")
      .split('"/api/jobs')
      .join('"/transformer/api/jobs'),
  );
};

const rewriteCoreText = (value: string) =>
  value
    .split("\n")
    .map((line) => {
      const eventData = /^(\s*data:\s*)(.*)$/.exec(line);
      if (!eventData) return rewriteCoreTextValue(line);
      try {
        return `${eventData[1]}${JSON.stringify(
          rewriteCoreUrls(JSON.parse(eventData[2] ?? "")),
        )}`;
      } catch {
        return rewriteCoreTextValue(line);
      }
    })
    .join("\n");

const sendCoreError = (res: Response, error: unknown) => {
  if (error instanceof CoreServiceError) {
    res.status(error.status).json(
      error.payload && typeof error.payload === "object"
        ? rewriteCoreUrls(error.payload)
        : { error: redactSensitiveText(error.message) },
    );
    return;
  }
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
  );
  res.status(500).json({ error: message });
};

export {
  CoreServiceError,
  assertCoreAvailable,
  coreUrl,
  getCoreServiceUrl,
  requestCore,
  requestCoreJson,
  redactSensitiveData,
  redactSensitiveText,
  rewriteCoreText,
  rewriteCoreUrls,
  sendCoreError,
};
