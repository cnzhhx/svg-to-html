import type { Response } from "express";
import {
  CoreClientError as SvgTransformCoreClientError,
  createSvgTransformClient,
} from "@svg-transform/core-client";

import { getBackendConfig } from "../config/index.js";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

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
    return new CoreServiceError(error.message, error.status, error.payload);
  }
  return error;
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

const rewriteCoreUrlValue = (value: string) => {
  const base = getCoreServiceUrl();
  let rewritten = value;
  if (value.startsWith(`${base}/api/jobs`)) {
    rewritten = `/transformer${value.slice(base.length)}`;
  } else if (value.startsWith("/api/jobs")) {
    rewritten = `/transformer${value}`;
  }
  return toJobRelativePathText(rewritten);
};

const rewriteCoreUrls = (value: unknown): unknown => {
  if (typeof value === "string") return rewriteCoreUrlValue(value);
  if (Array.isArray(value)) return value.map(rewriteCoreUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      rewriteCoreUrls(entry),
    ]),
  );
};

const rewriteCoreText = (value: string) => {
  const base = getCoreServiceUrl();
  return toJobRelativePathText(
    value
      .split(`${base}/api/jobs`)
      .join("/transformer/api/jobs")
      .split('"/api/jobs')
      .join('"/transformer/api/jobs'),
  );
};

const sendCoreError = (res: Response, error: unknown) => {
  if (error instanceof CoreServiceError) {
    res.status(error.status).json(
      error.payload && typeof error.payload === "object"
        ? rewriteCoreUrls(error.payload)
        : { error: error.message },
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message });
};

export {
  CoreServiceError,
  assertCoreAvailable,
  coreUrl,
  getCoreServiceUrl,
  requestCore,
  requestCoreJson,
  rewriteCoreText,
  rewriteCoreUrls,
  sendCoreError,
};
