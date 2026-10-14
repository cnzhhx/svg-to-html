import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { Router } from "express";
import multer from "multer";

import {
  DailyQuotaExceededError,
  getJobAccessStore,
  normalizeClientIp,
} from "../access/job-access.js";
import type { JobAccess } from "../access/job-access.js";
import { ensureClientKey } from "../access/client-session.js";
import { ARTIFACT_CSP, isSafeArtifactPath, isSafeJobId } from "../access/artifact-security.js";
import { isAdminRequest, requireSameOrigin, rateLimit } from "../access/admin-auth.js";
import adminRouter, { handleAdminError } from "./admin.js";
import { getGatewayStore, GatewayError } from "../settings/gateway-store.js";
import type { GatewayState } from "../settings/gateway-store.js";
import {
  requestCore,
  requestCoreJson,
  rewriteCoreText,
  rewriteCoreUrls,
  sendCoreError,
} from "../core-service/client.js";
import { optimizeCompareHtml } from "../core-service/compare-html.js";
import { JobSummaryCache } from "../core-service/job-summaries.js";
import { requestQueueSettings } from "../core-service/queue-settings.js";
import { getBackendConfig } from "../config/index.js";
import { buildJobQueueDetails } from "../queue/job-queue.js";
import type { JobQueueDetails } from "../queue/job-queue.js";

const router = Router();
router.param("id", (_req, res, next, id: string) => {
  if (!isSafeJobId(id)) { res.status(400).json({ error: "Invalid job ID" }); return; }
  next();
});
const accessStore = getJobAccessStore();
const jobSummaries = new JobSummaryCache(() => requestCoreJson<CoreJob[]>("/api/jobs"));
router.use(adminRouter);
router.use(async (_req, res, next) => {
  try { res.locals.gateway = await getGatewayStore().read(); next(); }
  catch (error) { handleAdminError(res, error); }
});
const snapshot = (res: import("express").Response) => res.locals.gateway as GatewayState;
const visibility = (state: GatewayState) => ({ accessIsolationEnabled: state.settings.accessIsolationEnabled, showcaseOverrides: state.showcaseOverrides });

type CoreJob = {
  [key: string]: unknown;
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

const JOB_CREATE_FIELD_KEYS = new Set([
  "dryRun",
  "jobCount",
  "model",
  "outputFormat",
  "scale",
  "showcase",
]);

const findUnsupportedCreateField = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (
    Object.keys(body as Record<string, unknown>).find(
      (key) => !JOB_CREATE_FIELD_KEYS.has(key),
    ) ?? null
  );
};

const upload = (maxBytes: number) => multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const name = decodeOriginalName(file.originalname);
    if (isSvgFileName(name) && getSvgDesignName(name)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only named SVG files are accepted"));
  },
  limits: { fileSize: maxBytes },
}).single("svg");

const appendIfPresent = (form: FormData, key: string, value: unknown) => {
  if (value === undefined || value === null || value === "") return;
  form.append(key, String(value));
};

const getClientIp = (req: import("express").Request) => {
  const ip = normalizeClientIp(req.ip ?? req.socket.remoteAddress);
  if (!ip) throw new Error("Client IP is unavailable");
  return ip;
};

const setPrivateNoStore = (res: import("express").Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
};

const getCoreJobId = (job: CoreJob) =>
  String(job.jobId || job.id || "").trim();

const decorateJob = (
  job: CoreJob,
  access: JobAccess,
  queue?: JobQueueDetails,
): CoreJob => ({
  ...job,
  accessMode: access.accessMode,
  isShowcase: access.isShowcase,
  capabilities: {
    canWrite: access.accessMode === "admin" || access.accessMode === "owner",
    canDelete: access.accessMode === "admin" || (access.accessMode === "owner" && !access.isShowcase),
  },
  ...(queue ? { queue } : {}),
});

const getQueueDetails = async (jobs: CoreJob[], state: GatewayState) => {
  if (!jobs.some(job => job.status === "queued")) return new Map<string, JobQueueDetails>();
  let maxConcurrentJobs: number;
  try { maxConcurrentJobs = (await requestQueueSettings()).maxConcurrentJobs; }
  catch (error) {
    // Older Core versions only expose the deployment environment limit.
    if (!(error instanceof GatewayError) || error.status !== 501) return new Map<string, JobQueueDetails>();
    maxConcurrentJobs = getBackendConfig().queue.maxConcurrentJobs;
  }
  return buildJobQueueDetails(jobs, {
    estimatedTaskMinutes: state.settings.estimatedTaskMinutes,
    maxConcurrentJobs,
  });
};

const requestWantsShowcase = (value: unknown) =>
  ["1", "true", "on"].includes(String(value ?? "").trim().toLowerCase());

const hasSingleJobCount = (value: unknown) => {
  if (value === undefined || value === null || value === "") return true;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed === 1;
};

const authorizeJob = async (
  req: import("express").Request,
  res: import("express").Response,
  jobId: string,
  write: boolean,
) => {
  let access: JobAccess | null;
  const policy = visibility(snapshot(res));
  if (await isAdminRequest(req)) {
    access = await accessStore.getAdminJobAccess(jobId, policy);
  } else {
    const clientIp = getClientIp(req);
    const clientKey = ensureClientKey(req, res);
    await accessStore.bindClientToOwnerJobs(clientIp, clientKey);
    access = await accessStore.getJobAccess(clientIp, jobId, clientKey, policy);
  }
  if (!access) {
    setPrivateNoStore(res);
    res.status(404).json({ error: "Job not found" });
    return null;
  }
  if (write && access.accessMode !== "admin" && access.accessMode !== "owner") {
    res.status(403).json({ error: "当前任务为只读，不能执行此操作" });
    return null;
  }
  return access;
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

router.get("/runtime", async (req, res) => {
  try {
    const clientKey = ensureClientKey(req, res);
    setPrivateNoStore(res);
    res.json({
      adminMode: await isAdminRequest(req),
      initialized: Boolean(snapshot(res).admin),
      settingsRevision: snapshot(res).revision,
      quotaEnabled: snapshot(res).settings.quotaEnabled,
      accessIsolationEnabled: snapshot(res).settings.accessIsolationEnabled,
      allowUserShowcase: snapshot(res).settings.allowUserShowcase,
      artifactRoot: "",
      coreServiceUrlConfigured: Boolean(getBackendConfig().core.serviceUrl),
      enableJobLocalStorage: false,
      jobChatDisabled: false,
      jobDeleteDisabled: false,
      modelOptions: readRuntimeModelOptions(),
      maxSvgUploadBytes: snapshot(res).settings.maxSvgUploadMb * 1024 * 1024,
      uploadQuota: await accessStore.getQuota(clientKey, snapshot(res).settings),
    });
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.post("/jobs", requireSameOrigin, (req, res) => {
  const settings = snapshot(res).settings;
  upload(settings.maxSvgUploadMb * 1024 * 1024)(req, res, async (error) => {
    try {
      if (error) {
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: `SVG 文件不能超过 ${settings.maxSvgUploadMb} MB` });
          return;
        }
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

      if (!hasSingleJobCount(req.body?.jobCount)) {
        res.status(400).json({ error: "每次上传只能创建 1 个转换任务" });
        return;
      }

      const clientIp = getClientIp(req);
      const clientKey = ensureClientKey(req, res);
      const showcase = requestWantsShowcase(req.body?.showcase);
      const adminMode = await isAdminRequest(req);
      if (showcase && !adminMode && !settings.allowUserShowcase) {
        res.status(403).json({ error: "当前不允许用户提交公开示例" }); return;
      }

      let reservedDate: string | undefined;
      let coreAccepted = false;
      try {
        if (!adminMode) {
          reservedDate = (await accessStore.reserveUpload(clientKey, settings)).date;
        }

        const coreJob = await createCoreJob(req.file, req.body ?? {});
        jobSummaries.invalidate();
        coreAccepted = true;
        const jobId = getCoreJobId(coreJob);
        if (!jobId) throw new Error("Core job response did not include a job ID");
        await accessStore.registerJob(clientIp, jobId, showcase, clientKey);

        const rewrittenJob = rewriteCoreUrls(coreJob) as CoreJob;
        const job = decorateJob(rewrittenJob, {
          accessMode: adminMode ? "admin" : "owner",
          isShowcase: showcase,
        });
        res.status(202).json({
          designName:
            job.designName ??
            getSvgDesignName(decodeOriginalName(req.file.originalname)),
          job,
          jobId,
          quota: await accessStore.getQuota(clientKey, settings),
          status: job.status ?? "draft",
        });
      } catch (caughtError) {
        if (reservedDate && !coreAccepted) {
          await accessStore.refundUpload(clientKey, reservedDate, settings);
        }
        throw caughtError;
      }
    } catch (caughtError) {
      if (caughtError instanceof DailyQuotaExceededError) {
        res.status(429).json({
          error: caughtError.message,
          quota: caughtError.quota,
        });
        return;
      }
      sendCoreError(res, caughtError);
    }
  });
});

router.get("/jobs", async (req, res) => {
  try {
    setPrivateNoStore(res);
    const clientIp = getClientIp(req);
    const adminMode = await isAdminRequest(req);
    const clientKey = adminMode ? undefined : ensureClientKey(req, res);
    if (clientKey) {
      await accessStore.bindClientToOwnerJobs(clientIp, clientKey);
    }
    const coreJobs = await jobSummaries.read();
    const queueDetails = await getQueueDetails(coreJobs, snapshot(res));
    const visibleJobs = await Promise.all(
      (Array.isArray(coreJobs) ? coreJobs : []).map(async (coreJob) => {
        const jobId = getCoreJobId(coreJob);
        if (!jobId) return null;
        const access = adminMode
          ? await accessStore.getAdminJobAccess(jobId, visibility(snapshot(res)))
          : await accessStore.getJobAccess(clientIp, jobId, clientKey, visibility(snapshot(res)));
        if (!access) return null;
        return decorateJob(
          rewriteCoreUrls(coreJob) as CoreJob,
          access,
          queueDetails.get(jobId),
        );
      }),
    );
    res.json(visibleJobs.filter(Boolean));
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.get("/jobs/:id", async (req, res) => {
  try {
    setPrivateNoStore(res);
    const jobId = String(req.params["id"] ?? "");
    const access = await authorizeJob(req, res, jobId, false);
    if (!access) return;
    const coreJob = await requestCoreJson<CoreJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
    const coreJobs = coreJob.status === "queued" ? await jobSummaries.read() : [];
    const job = rewriteCoreUrls(coreJob) as CoreJob;
    res.json(decorateJob(job, access, (await getQueueDetails(coreJobs, snapshot(res))).get(jobId)));
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.post("/jobs/:id/start", requireSameOrigin, async (req, res) => {
  res.once("finish", () => { if (res.statusCode < 400) jobSummaries.invalidate(); });
  try {
    const jobId = String(req.params["id"] ?? "");
    const access = await authorizeJob(req, res, jobId, true);
    if (!access) return;
    res.json(
      rewriteCoreUrls(
        await requestCoreJson(`/api/jobs/${encodeURIComponent(jobId)}/start`, {
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

router.post("/jobs/:id/messages", requireSameOrigin, async (req, res) => {
  res.once("finish", () => { if (res.statusCode < 400) jobSummaries.invalidate(); });
  try {
    const jobId = String(req.params["id"] ?? "");
    const access = await authorizeJob(req, res, jobId, true);
    if (!access) return;
    res.status(202).json(
      rewriteCoreUrls(
        await requestCoreJson(`/api/jobs/${encodeURIComponent(jobId)}/messages`, {
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

router.delete("/jobs/:id", requireSameOrigin, async (req, res) => {
  res.once("finish", () => { if (res.statusCode < 400) jobSummaries.invalidate(); });
  try {
    const jobId = String(req.params["id"] ?? "");
    const access = await authorizeJob(req, res, jobId, false);
    if (!access) return;
    if (access.accessMode !== "admin") {
      if (access.isShowcase) {
        res.status(403).json({ error: "示例任务不能删除" });
        return;
      }
      if (access.accessMode !== "owner") {
        res.status(403).json({ error: "当前任务不能删除" });
        return;
      }
    }
    const response = rewriteCoreUrls(
      await requestCoreJson(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      }),
    );
    await accessStore.forgetJob(jobId);
    res.json(response);
  } catch (error) {
    sendCoreError(res, error);
  }
});

router.put("/admin/jobs/:id/showcase", requireSameOrigin, rateLimit(60, 60_000), async (req, res) => {
  try {
    if (!await isAdminRequest(req)) throw new GatewayError(401, "请先登录管理员账号");
    if (typeof req.body?.showcase !== "boolean" || !Number.isSafeInteger(req.body?.revision)) throw new GatewayError(400, "示例状态或版本号无效");
    const jobId = String(req.params["id"] ?? "");
    await requestCoreJson(`/api/jobs/${encodeURIComponent(jobId)}`);
    await getGatewayStore().mutate(state => {
      Object.defineProperty(state.showcaseOverrides, jobId, { value: req.body.showcase, writable: true, configurable: true, enumerable: true });
    }, req.body.revision);
    const state = await getGatewayStore().read();
    res.json({ jobId, isShowcase: state.showcaseOverrides[jobId], revision: state.revision });
  } catch (error) { handleAdminError(res, error); }
});

// Also enforce revocation on requests already streaming when settings change.
// Polling covers expiry and changes made by the local recovery CLI.
const watchReadAccess = (req: import("express").Request, res: import("express").Response, jobId: string) => {
  const controller = new AbortController();
  const clientKey = ensureClientKey(req, res);
  const check = async () => {
    if (controller.signal.aborted) return false;
    try {
      const state = await getGatewayStore().read();
      const allowed = await isAdminRequest(req) || await accessStore.getJobAccess(getClientIp(req), jobId, clientKey, visibility(state));
      if (allowed) return true;
    } catch { /* Fail closed if persisted policy cannot be read. */ }
    controller.abort();
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
    return false;
  };
  const onChange = () => { void check(); };
  const timer = setInterval(onChange, 1000);
  timer.unref();
  getGatewayStore().changes.on("change", onChange);
  const close = () => {
    clearInterval(timer); getGatewayStore().changes.off("change", onChange); controller.abort();
  };
  res.once("close", close);
  return { check, signal: controller.signal, close };
};

const proxyCoreResponse = async (
  req: import("express").Request,
  res: import("express").Response,
  jobId: string,
  corePath: string,
  transformText?: (value: string) => string,
) => {
  let guard: ReturnType<typeof watchReadAccess> | undefined;
  try {
    const access = await authorizeJob(req, res, jobId, false);
    if (!access) return;
    guard = watchReadAccess(req, res, jobId);
    const coreResponse = await requestCore(corePath, { signal: guard.signal });
    if (!await guard.check()) return;
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Cookie");
    const contentType = coreResponse.headers.get("content-type");
    res.setHeader("Content-Security-Policy", ARTIFACT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const contentDisposition = coreResponse.headers.get("content-disposition");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
    if (transformText) {
      const body = transformText(await coreResponse.text());
      if (!await guard.check()) return;
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.end(body);
      return;
    }
    if (!coreResponse.body) {
      res.end();
      return;
    }
    const reader = coreResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!await guard.check()) return;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    if (res.destroyed || guard?.signal.aborted) return;
    if (res.headersSent) { res.destroy(); return; }
    if (!res.headersSent) setPrivateNoStore(res);
    sendCoreError(res, error);
  } finally { guard?.close(); }
};

router.get("/jobs/:id/preview", (req, res) => {
  const jobId = String(req.params["id"] ?? "");
  void proxyCoreResponse(
    req,
    res,
    jobId,
    `/api/jobs/${encodeURIComponent(jobId)}/preview`,
  );
});

router.get("/jobs/:id/files/*path", (req, res) => {
  const pathParam = req.params["path"];
  const rawPath = Array.isArray(pathParam) ? pathParam.join("/") : String(pathParam ?? "");
  if (!isSafeArtifactPath(rawPath)) { res.status(400).json({ error: "Invalid artifact path" }); return; }
  const encodedPath = rawPath.split("/").map(encodeURIComponent).join("/");
  const jobId = String(req.params["id"] ?? "");
  const isComparePage = rawPath.toLowerCase().endsWith(".compare.html");
  void proxyCoreResponse(
    req,
    res,
    jobId,
    `/api/jobs/${encodeURIComponent(jobId)}/files/${encodedPath}`,
    isComparePage ? optimizeCompareHtml : undefined,
  );
});

router.get("/jobs/:id/download", (req, res) => {
  const jobId = String(req.params["id"] ?? "");
  void proxyCoreResponse(
    req,
    res,
    jobId,
    `/api/jobs/${encodeURIComponent(jobId)}/download`,
  );
});

router.get("/jobs/:id/events", async (req, res) => {
  let guard: ReturnType<typeof watchReadAccess> | undefined;
  try {
    const jobId = String(req.params["id"] ?? "");
    const access = await authorizeJob(req, res, jobId, false);
    if (!access) return;
    guard = watchReadAccess(req, res, jobId);
    const coreResponse = await requestCore(`/api/jobs/${encodeURIComponent(jobId)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: guard.signal,
    });
    if (!await guard.check()) return;
    res.writeHead(200, {
      "Cache-Control": "private, no-store, no-transform",
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
      if (!await guard.check()) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        res.write(`${rewriteCoreText(part)}\n\n`);
      }
    }
    if (buffer && await guard.check()) res.write(rewriteCoreText(buffer));
    res.end();
  } catch (error) {
    if (res.destroyed || guard?.signal.aborted) return;
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    sendCoreError(res, error);
  } finally { guard?.close(); }
});

export default router;
