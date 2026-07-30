import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";

import { Router } from "express";
import multer from "multer";

import {
  requestCore,
  requestCoreJson,
  rewriteCoreText,
  rewriteCoreUrls,
  sendCoreError,
} from "../core-service/client.js";
import { getBackendConfig } from "../config/index.js";

const router = Router();

type CoreJob = {
  designName?: string;
  id?: string;
  jobId?: string;
  status?: string;
};

const decodeOriginalName = (value: string) =>
  path.basename(Buffer.from(value, "latin1").toString("utf8"));

const isSvgFileName = (value: string) =>
  path.extname(value).toLowerCase() === ".svg";

const getSvgDesignName = (value: string) =>
  path.basename(value, path.extname(value)).trim();

const parseJobCount = (value: unknown) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) {
    return Math.floor(parsed);
  }
  return 1;
};

const JOB_CREATE_FIELD_KEYS = new Set([
  "dryRun",
  "jobCount",
  "model",
  "outputFormat",
  "scale",
]);

const findUnsupportedCreateField = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (
    Object.keys(body as Record<string, unknown>).find(
      (key) => !JOB_CREATE_FIELD_KEYS.has(key),
    ) ?? null
  );
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const name = decodeOriginalName(file.originalname);
    if (isSvgFileName(name) && getSvgDesignName(name)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only named SVG files are accepted"));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
}).single("svg");

const appendIfPresent = (form: FormData, key: string, value: unknown) => {
  if (value === undefined || value === null || value === "") return;
  form.append(key, String(value));
};

const readRuntimeModelOptions = () => {
  const configPath = getBackendConfig().core.modelConfigPath;
  try {
    if (!existsSync(configPath)) return [];
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const models = (parsed as { models?: unknown }).models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return [];
    return Object.keys(models).filter((key) => key.trim());
  } catch {
    return [];
  }
};

const createCoreJob = async (file: Express.Multer.File, body: Record<string, unknown>) => {
  const form = new FormData();
  const bytes = new Uint8Array(file.buffer.byteLength);
  bytes.set(file.buffer);
  form.append("svg", new Blob([bytes.buffer], { type: file.mimetype || "image/svg+xml" }), decodeOriginalName(file.originalname));
  appendIfPresent(form, "model", body["model"]);
  appendIfPresent(form, "outputFormat", body["outputFormat"]);
  appendIfPresent(form, "scale", body["scale"]);
  appendIfPresent(form, "dryRun", body["dryRun"]);
  return requestCoreJson<CoreJob>("/api/jobs", {
    body: form,
    method: "POST",
  });
};

router.get("/runtime", (_req, res) => {
  res.json({
    coreServiceUrlConfigured: true,
    enableJobLocalStorage: true,
    jobChatDisabled: false,
    jobDeleteDisabled: false,
    modelOptions: readRuntimeModelOptions(),
    nodeVersion: process.version,
    platform: process.platform,
    release: os.release(),
    artifactRoot: "",
  });
});

router.post("/jobs", (req, res) => {
  upload(req, res, async (error) => {
    try {
      if (error) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No SVG file provided" });
        return;
      }
      const unsupportedField = findUnsupportedCreateField(req.body);
      if (unsupportedField) {
        res.status(400).json({ error: `Unsupported job field: ${unsupportedField}` });
        return;
      }

      const jobCount = parseJobCount(req.body?.jobCount);
      const jobs = [];
      for (let index = 0; index < jobCount; index += 1) {
        jobs.push(await createCoreJob(req.file, req.body ?? {}));
      }
      const rewrittenJobs = rewriteCoreUrls(jobs) as CoreJob[];
      const jobIds = rewrittenJobs.map((job) => String(job.jobId || job.id || "")).filter(Boolean);
      const first = rewrittenJobs[0];
      const response =
        jobCount === 1
          ? {
              designName: first?.designName ?? getSvgDesignName(decodeOriginalName(req.file.originalname)),
              job: first,
              jobId: first?.jobId ?? first?.id,
              status: first?.status ?? "draft",
            }
          : {
              designName: first?.designName ?? getSvgDesignName(decodeOriginalName(req.file.originalname)),
              jobIds,
              jobs: rewrittenJobs,
              status: "draft",
            };
      res.status(202).json(response);
    } catch (caughtError) {
      sendCoreError(res, caughtError);
    }
  });
});

router.get("/jobs", async (_req, res) => {
  try {
    res.json(rewriteCoreUrls(await requestCoreJson("/api/jobs")));
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    res.json(rewriteCoreUrls(await requestCoreJson(`/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}`)));
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.post("/jobs/:id/start", async (req, res) => {
  try {
    res.json(
      rewriteCoreUrls(
        await requestCoreJson(`/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/start`, {
          body: JSON.stringify(req.body ?? {}),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      ),
    );
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.post("/jobs/:id/messages", async (req, res) => {
  try {
    res.status(202).json(
      rewriteCoreUrls(
        await requestCoreJson(`/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/messages`, {
          body: JSON.stringify(req.body ?? {}),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      ),
    );
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.delete("/jobs/:id", async (req, res) => {
  try {
    res.json(
      rewriteCoreUrls(
        await requestCoreJson(`/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}`, {
          method: "DELETE",
        }),
      ),
    );
  } catch (error) {
    sendCoreError(res, error);
  }
});

const proxyCoreResponse = async (res: import("express").Response, path: string) => {
  try {
    const coreResponse = await requestCore(path);
    const contentType = coreResponse.headers.get("content-type");
    const contentDisposition = coreResponse.headers.get("content-disposition");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
    if (!coreResponse.body) {
      res.end();
      return;
    }
    const reader = coreResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    sendCoreError(res, error);
  }
};

router.get("/jobs/:id/preview", (req, res) => {
  void proxyCoreResponse(res, `/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/preview`);
});

router.get("/jobs/:id/files/*path", (req, res) => {
  const pathParam = req.params["path"];
  const rawPath = Array.isArray(pathParam) ? pathParam.join("/") : String(pathParam ?? "");
  const encodedPath = rawPath.split("/").map(encodeURIComponent).join("/");
  void proxyCoreResponse(res, `/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/files/${encodedPath}`);
});

router.get("/jobs/:id/download", (req, res) => {
  void proxyCoreResponse(res, `/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/download`);
});

router.get("/jobs/:id/events", async (req, res) => {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  req.on("close", () => controller.abort());

  try {
    const coreResponse = await requestCore(`/api/jobs/${encodeURIComponent(String(req.params["id"] ?? ""))}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    res.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    if (!coreResponse.body) {
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    const reader = coreResponse.body.getReader();
    let buffer = "";
    while (!res.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        res.write(`${rewriteCoreText(part)}\n\n`);
      }
    }
    if (buffer) res.write(rewriteCoreText(buffer));
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    sendCoreError(res, error);
  }
});

export default router;
