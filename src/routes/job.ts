import { Router } from "express";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import archiver from "archiver";

import {
  DIFF_RATIO_THRESHOLD,
  MAX_CONCURRENT_AGENTS,
  SESSION_CHAT_DISABLED,
  SESSION_DELETE_DISABLED,
  SESSION_LOCAL_STORAGE_ENABLED,
} from "../config/index.js";
import { detectBrowserBinary } from "../core/cdp.js";
import { truncate } from "../core/string-utils.js";
import { getWorkspaceRoot } from "../core/paths.js";
import { cancelSessionRun, enqueueSession } from "../pipeline/agent-runner/index.js";
import {
  sessionStore,
  type Session,
  type SessionMessage,
  type SessionResult,
} from "../session-store.js";

const router = Router();

const API_MESSAGE_TEXT_LIMIT = Number.POSITIVE_INFINITY;
const API_EVENT_MESSAGE_TEXT_LIMIT = 100;
const API_REASONING_MESSAGE_TEXT_LIMIT = 4_000;
const API_LOG_TEXT_LIMIT = 2_000;
const API_RECENT_LOG_LIMIT = 40;
const SESSION_DELETE_CLEANUP_ATTEMPTS = 3;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const truncateApiText = (value: unknown, limit: number) =>
  truncate(String(value ?? ""), limit, "…");

const safeMessagesForApi = (
  messages: SessionMessage[],
  { includeMessages }: { includeMessages: boolean },
) => {
  if (!includeMessages) return [];
  return messages
    .slice(-100)
    .map((message) => ({
      ...message,
      text: truncateApiText(
        message.text,
        message.agentItemType === "reasoning"
          ? API_REASONING_MESSAGE_TEXT_LIMIT
          : message.kind === "event"
            ? API_EVENT_MESSAGE_TEXT_LIMIT
            : API_MESSAGE_TEXT_LIMIT,
      ),
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

const deriveTokenSplitFromEvents = (session: Session) => {
  if (
    session.result.cachedInputTokens !== undefined &&
    session.result.uncachedInputTokens !== undefined
  ) {
    return {};
  }

  const eventsPath = path.join(session.sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return {};

  let cachedInputTokens = 0;
  let eventInputTokens = 0;
  try {
    for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as {
        event?: {
          type?: string;
          usage?: {
            cached_input_tokens?: number;
            input_tokens?: number;
          };
        };
        type?: string;
      };
      if (
        parsed.type !== "agent:event" ||
        parsed.event?.type !== "turn.completed"
      ) {
        continue;
      }
      const usage = parsed.event.usage;
      cachedInputTokens += Number(usage?.cached_input_tokens ?? 0);
      eventInputTokens += Number(usage?.input_tokens ?? 0);
    }
  } catch {
    return {};
  }

  if (eventInputTokens <= 0 && cachedInputTokens <= 0) return {};
  const inputTokens = Number(session.result.inputTokens ?? eventInputTokens);
  return {
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
  };
};

const safeResultForApi = (
  session: Session,
  { summary }: { summary: boolean },
): SessionResult => {
  const result = {
    ...session.result,
    ...(summary ? {} : deriveTokenSplitFromEvents(session)),
  };
  const summaryKeys: Array<keyof SessionResult> = [
    "diffRatio",
    "moduleCount",
    "verifyMode",
  ];
  const detailKeys: Array<keyof SessionResult> = [
    "artifactDir",
    "compareEntryPath",
    "containerLayoutPath",
    "designWidth",
    "designHeight",
    "diffRatio",
    "cachedInputTokens",
    "inputTokens",
    "moduleAgentRuns",
    "moduleAgentThreadIds",
    "moduleAgentManifestPath",
    "moduleConcurrencyLimit",
    "moduleCount",
    "moduleCountExceedsConcurrency",
    "moduleDiffRegionsPath",
    "moduleFailedIds",
    "moduleFailureKinds",
    "moduleFailures",
    "moduleManifestPath",
    "moduleMergeManifestPath",
    "modulePlanMarkdownPath",
    "modulePlanMode",
    "modulePlanPath",
    "modulePlanQualityMarkdownPath",
    "modulePlanQualityPath",
    "moduleValidationRuns",
    "multiAgentRoute",
    "multiAgentRouteReason",
    "modelTelemetryRecords",
    "modelUsageRecords",
    "outputTokens",
    "outputTarget",
    "renderEntryPath",
    "renderPngPath",
    "regionsPath",
    "sourceEntryPath",
    "sourceStylePath",
    "sourceBasis",
    "sourceRenderMode",
    "svgPngPath",
    "textTuningAppliedCount",
    "textTuningReportPath",
    "tokensUsed",
    "uncachedInputTokens",
    "verifyMode",
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
  result: safeResultForApi(session, {
    summary,
  }),
});

const isCompletedSessionStatus = (status: string) =>
  status === "completed" ||
  status === "best-effort" ||
  status === "failed-gate";

const canStartSession = (status: string) =>
  status === "draft" ||
  status === "failed" ||
  isCompletedSessionStatus(status);

const canAcceptUserMessage = (status: string) =>
  status !== "queued" && status !== "running";

const forceDeleteSessionFilesWithRetry = async (session: Session) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_DELETE_CLEANUP_ATTEMPTS; attempt++) {
    try {
      await sessionStore.forceDeleteSessionFiles(session);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < SESSION_DELETE_CLEANUP_ATTEMPTS) {
        await delay(250 * attempt);
      }
    }
  }
  throw lastError;
};

const scheduleForceDeleteSessionFiles = (
  session: Session,
  phase: "initial" | "final",
) => {
  void forceDeleteSessionFilesWithRetry(session).catch((error) => {
    console.error(
      `[session-delete] ${phase} cleanup failed (${session.id}):`,
      error,
    );
  });
};

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
  if (SESSION_CHAT_DISABLED) {
    res.status(403).json({ error: "Session chat is disabled" });
    return;
  }

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

router.delete("/sessions/:id", async (req, res) => {
  if (SESSION_DELETE_DISABLED) {
    res.status(403).json({ error: "Session deletion is disabled" });
    return;
  }

  const session = sessionStore.get(String(req.params["id"] ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const canceledRun =
    session.status === "queued" || session.status === "running"
      ? cancelSessionRun(session.id)
      : undefined;
  try {
    const deletedSession = canceledRun?.active
      ? sessionStore.detachSession(session.id)
      : await sessionStore.deleteSession(session.id);
    if (canceledRun?.active && deletedSession) {
      scheduleForceDeleteSessionFiles(deletedSession, "initial");
      void canceledRun.finished.then(() => {
        scheduleForceDeleteSessionFiles(deletedSession, "final");
      });
    }
    res.json({ deleted: true, sessionId: session.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canceledRun?.queued && sessionStore.get(session.id)) {
      enqueueSession(session.id);
    }
    res.status(500).json({ error: message });
  }
});

router.get("/runtime", (_req, res) => {
  res.json({
    browserPath: detectBrowserBinary() ?? null,
    maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
    nodeVersion: process.version,
    platform: process.platform,
    release: os.release(),
    diffRatioThreshold: DIFF_RATIO_THRESHOLD,
    workspaceRoot: getWorkspaceRoot(),
    enableSessionLocalStorage: SESSION_LOCAL_STORAGE_ENABLED,
    sessionDeleteDisabled: SESSION_DELETE_DISABLED,
    sessionChatDisabled: SESSION_CHAT_DISABLED,
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

  // Export the full session folder so the frontend gets source entries,
  // render previews, reports, assets, and persisted session metadata together.
  archive.directory(session.sessionDir, session.designName || session.id);

  await archive.finalize();
});

export default router;
