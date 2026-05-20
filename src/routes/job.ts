import { Router } from "express";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import archiver from "archiver";

import { DIFF_RATIO_THRESHOLD } from "../config/runtime.js";
import { getWorkspaceRoot } from "../core/utils.js";
import { pauseSession, enqueueSession } from "../pipeline/agent-runner.js";
import { MAX_CONCURRENT_AGENTS } from "../pipeline/agent-runner/config.js";
import {
  sessionStore,
  type Session,
  type SessionMessage,
  type SessionResult,
} from "../session-store.js";

const router = Router();

const API_MESSAGE_TEXT_LIMIT = 20_000;
const API_LOG_TEXT_LIMIT = 2_000;
const API_RECENT_LOG_LIMIT = 40;

const truncateApiText = (value: unknown, limit: number) => {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const safeMessagesForApi = (
  messages: SessionMessage[],
  { includeMessages }: { includeMessages: boolean },
) => {
  if (!includeMessages) return [];
  return messages
    .filter((message) => message.codexItemType !== "reasoning")
    .slice(-100)
    .map((message) => ({
      ...message,
      text: truncateApiText(message.text, API_MESSAGE_TEXT_LIMIT),
    }));
};

const safeLogsForApi = (
  logs: string[],
  { includeLogs }: { includeLogs: boolean },
) => {
  if (!includeLogs) return [];
  return logs
    .slice(-API_RECENT_LOG_LIMIT)
    .map((log) => truncateApiText(log, API_LOG_TEXT_LIMIT));
};

const safeResultForApi = (
  result: SessionResult,
  { summary }: { summary: boolean },
): SessionResult => {
  const summaryKeys: Array<keyof SessionResult> = [
    "diffRatio",
    "finalOutputReady",
    "moduleCount",
    "qualityStatus",
    "verifyMode",
  ];
  const detailKeys: Array<keyof SessionResult> = [
    "agentTimeoutMs",
    "artifactDir",
    "compareHtmlPath",
    "containerLayoutPath",
    "diffPngPath",
    "diffRatio",
    "finalOutputPolicyPassed",
    "finalOutputPolicyPath",
    "finalOutputReady",
    "frameworkExports",
    "fontRenderingLimitLikely",
    "fontRenderingLimitReason",
    "htmlPath",
    "htmlPngPath",
    "inputTokens",
    "layoutBoxPassed",
    "layoutBoxReportPath",
    "moduleAgentRuns",
    "moduleConcurrencyLimit",
    "moduleCount",
    "moduleCountExceedsConcurrency",
    "moduleDiffRegionsPath",
    "moduleFailedIds",
    "modulePlanMode",
    "modulePlanPath",
    "moduleRegionsPath",
    "moduleRegionDiffPassed",
    "moduleRegionDiffThreshold",
    "moduleTextLayoutMissingSelectorCount",
    "moduleTextLayoutSelectorCheckPassed",
    "multiAgentRoute",
    "multiAgentRouteReason",
    "ocrProvider",
    "outputTokens",
    "qualityStatus",
    "regionsPath",
    "shellManifestPath",
    "svgPngPath",
    "textBoxReportPath",
    "textContentPriorityIssueCount",
    "textGeometryPriorityIssueCount",
    "textInsightsPath",
    "textPriorityIssueCount",
    "textTuningAppliedCount",
    "textTuningReportPath",
    "tokensUsed",
    "verifyMode",
    "verifyReportPath",
    "workflowLintPassed",
    "workflowLintPath",
  ];
  const safeKeys = summary ? summaryKeys : detailKeys;
  const safe = Object.fromEntries(
    safeKeys
      .filter((key) => result[key] !== undefined)
      .map((key) => [key, result[key]]),
  ) as SessionResult;
  return safe;
};

const sessionForApi = (
  session: Session,
  { summary = false }: { summary?: boolean } = {},
): Session & { __summary?: boolean } => ({
  ...session,
  __summary: summary || undefined,
  logs: safeLogsForApi(session.logs, { includeLogs: !summary }),
  messages: safeMessagesForApi(session.messages, { includeMessages: !summary }),
  pendingUserMessages: [],
  result: safeResultForApi(session.result, {
    summary,
  }),
});

const isCompletedSessionStatus = (status: string) =>
  status === "completed" ||
  status === "best-effort" ||
  status === "failed-gate";

const canStartSession = (status: string) =>
  status === "draft" ||
  status === "paused" ||
  status === "failed" ||
  isCompletedSessionStatus(status);

const canResumeSession = (status: string) =>
  status === "paused" || status === "failed" || isCompletedSessionStatus(status);

const canAcceptUserMessage = (status: string) =>
  status !== "queued" && status !== "running";



router.get("/sessions/:id", (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(sessionForApi(session));
});

router.get("/sessions", (_req, res) => {
  res.json(
    sessionStore
      .list()
      .map((session) => sessionForApi(session, { summary: true })),
  );
});

router.post("/sessions/:id/start", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.status === "queued" || session.status === "running") {
    res.json({ sessionId: session.id, status: session.status });
    return;
  }
  if (!canStartSession(session.status)) {
    res
      .status(409)
      .json({ error: `Cannot start session from status ${session.status}` });
    return;
  }
  enqueueSession(session.id);
  res.json({ sessionId: session.id, status: "queued" });
});

router.post("/sessions/:id/messages", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  const text = String(req.body?.text ?? "").trim();
  const moduleId = String(req.body?.moduleId ?? "").trim();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Message text is required" });
    return;
  }
  if (!moduleId) {
    res.status(400).json({ error: "请选择要修复的模块" });
    return;
  }
  if (!canAcceptUserMessage(session.status)) {
    res
      .status(409)
      .json({ error: `Cannot enqueue message from status ${session.status}` });
    return;
  }
  sessionStore.addMessage(
    session.id,
    {
      id: `user-${Date.now()}`,
      kind: "chat",
      moduleId,
      role: "user",
      text,
    },
    { enqueueForAgent: true },
  );
  enqueueSession(session.id);
  res.json({ sessionId: session.id, status: "queued" });
});

router.post("/sessions/:id/pause", (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.status !== "running" && session.status !== "queued") {
    res
      .status(409)
      .json({ error: `Cannot pause session from status ${session.status}` });
    return;
  }
  pauseSession(session.id);
  res.json({ sessionId: session.id, status: "paused" });
});

router.post("/sessions/:id/resume", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.status === "queued" || session.status === "running") {
    res.json({ sessionId: session.id, status: session.status });
    return;
  }
  if (!canResumeSession(session.status)) {
    res
      .status(409)
      .json({ error: `Cannot resume session from status ${session.status}` });
    return;
  }
  const text = String(req.body?.text ?? "").trim();
  const moduleId = String(req.body?.moduleId ?? "").trim();
  if (text) {
    if (!moduleId) {
      res.status(400).json({ error: "请选择要修复的模块" });
      return;
    }
    sessionStore.addMessage(
      session.id,
      {
        id: `user-${Date.now()}`,
        kind: "chat",
        moduleId,
        role: "user",
        text,
      },
      { enqueueForAgent: true },
    );
  }
  enqueueSession(session.id);
  res.json({ sessionId: session.id, status: "queued" });
});

router.delete("/sessions/:id", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (session.status === "queued" || session.status === "running") {
    pauseSession(session.id);
  }

  try {
    await sessionStore.deleteSession(session.id);
    res.json({ deleted: true, sessionId: session.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.get("/runtime", (_req, res) => {
  res.json({
    agentTimeoutMs: null,
    browserPath:
      process.env["CHROMIUM_PATH"] ||
      process.env["CHROME_PATH"] ||
      process.env["BROWSER_PATH"] ||
      null,
    maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
    nodeVersion: process.version,
    ocrProvider: process.env["OCR_PROVIDER"] || null,
    platform: process.platform,
    release: os.release(),
    diffRatioThreshold: DIFF_RATIO_THRESHOLD,
    workspaceRoot: getWorkspaceRoot(),
  });
});

router.get("/sessions/:id/download", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  if (!existsSync(session.sessionDir)) {
    res.status(404).json({ error: "Session directory not found" });
    return;
  }

  const zipName = `${session.designName || session.id}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
  );

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.destroy(error);
  });
  archive.pipe(res);

  // Export the full session folder so the frontend gets all source files,
  // generated HTML, reports, assets, and persisted session metadata together.
  archive.directory(session.sessionDir, session.designName || session.id);

  await archive.finalize();
});

router.get("/sessions/:id/exports/:target/download", async (req, res) => {
  const session = sessionStore.get(String(req.params["id"] ?? ""));
  const target = String(req.params["target"] ?? "").trim().toLowerCase();
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (target !== "react" && target !== "vue") {
    res.status(400).json({ error: "Export target must be react or vue" });
    return;
  }

  const configuredDir = session.result.frameworkExports?.[target]?.dir;
  const exportDir = configuredDir ?? path.join(session.artifactDir, "exports", target);
  if (!existsSync(exportDir)) {
    res.status(404).json({ error: `${target} export directory not found` });
    return;
  }

  const zipName = `${session.designName || session.id}-${target}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
  );

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.destroy(error);
  });
  archive.pipe(res);
  archive.directory(exportDir, target);
  await archive.finalize();
});

export default router;
