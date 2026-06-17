import { EventEmitter } from "node:events";

import {
  MAX_SESSION_LOG_CHARS,
  MAX_SESSION_LOG_ENTRIES,
  emitSessionEvent,
  truncateText,
} from "./session-store/events.js";
import { ensureWorkflowProgress } from "./session-store/progress.js";
import {
  sessionMessageFromAgentEvent,
  upsertSessionMessage,
} from "./session-store/messages.js";
import { SessionPersistence } from "./session-store/persistence.js";
import { loadSessionSnapshots } from "./session-store/snapshots.js";
import * as mutateSession from "./session-store/session-mutations.js";
import type {
  PipelineStep,
  Session,
  SessionEvent,
  SessionMessage,
  SessionMessageRole,
  PendingUserMessage,
  WorkflowArchiveEntry,
  WorkflowNodeKey,
  WorkflowProgress,
} from "./session-store/types.js";

class SessionStore extends EventEmitter {
  private sessions = new Map<string, Session>();
  private persistence = new SessionPersistence(
    this.sessions,
    this.emitVolatileSessionUpdate.bind(this),
  );

  private emitVolatileSessionUpdate(sessionId: string, data: Partial<Session>) {
    const event: SessionEvent = {
      type: "session:updated",
      sessionId,
      data,
      timestamp: Date.now(),
    };
    this.emit(`session:${sessionId}`, event);
    this.emit("session:*", event);
  }

  private upsertMessageRecord(
    session: Session,
    message: Omit<SessionMessage, "createdAt">,
    options?: { enqueueForAgent?: boolean },
  ) {
    const created = upsertSessionMessage(session, message, options);
    this.persistence.persistMessage(session, created);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "message",
      sessionId: session.id,
      message: created,
      timestamp: Date.now(),
    });
  }

  private persistAgentMessage(
    sessionId: string,
    event: Record<string, unknown>,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const message = sessionMessageFromAgentEvent(event);
    if (message) this.upsertMessageRecord(session, message);
  }

  async hydrateFromDisk() {
    for (const session of await loadSessionSnapshots()) {
      const status = String(session.status);
      const supportedStatuses = new Set([
        "draft",
        "queued",
        "running",
        "completed",
        "failed",
        "best-effort",
        "failed-gate",
      ]);
      if (status === "running") {
        mutateSession.resetInFlightExecution(session);
        mutateSession.markQueued(session);
      } else if (!supportedStatuses.has(status)) {
        mutateSession.failPipeline(
          session,
          "旧版 session 状态已不再支持，请重新启动或删除",
        );
      }
      this.sessions.set(session.id, session);
      this.persistence.persistSnapshot(session);
    }
  }

  create(session: Omit<Session, "createdAt" | "updatedAt">): Session {
    const created = {
      ...session,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    ensureWorkflowProgress(created);
    this.sessions.set(created.id, created);
    this.persistence.persistSnapshot(created);
    created.messages.forEach((message) => {
      this.persistence.persistMessage(created, message);
    });
    return created;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    ensureWorkflowProgress(session);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()]
      .map((session) => {
        ensureWorkflowProgress(session);
        return session;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteSession(id: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    try {
      await this.persistence.deleteSession(session);
    } catch (error) {
      this.sessions.set(id, session);
      throw error;
    }
    const event: SessionEvent = {
      type: "session:deleted",
      sessionId: id,
      timestamp: Date.now(),
    };
    this.emit(`session:${id}`, event);
    this.emit("session:*", event);
    return session;
  }

  update(id: string, patch: Partial<Session>) {
    const session = this.sessions.get(id);
    if (!session) return;
    Object.assign(session, patch);
    ensureWorkflowProgress(session);
    session.updatedAt = Date.now();
    const event: SessionEvent = {
      type: "session:updated",
      sessionId: id,
      data: patch,
      timestamp: Date.now(),
    };
    this.persistence.persistSnapshot(session);
    this.emitEvent(event);
  }

  addMessage(
    sessionId: string,
    message: Omit<SessionMessage, "createdAt">,
    options?: { enqueueForAgent?: boolean },
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.upsertMessageRecord(session, message, options);
  }

  addBehavior(
    sessionId: string,
    text: string,
    role: SessionMessageRole = "assistant",
  ) {
    this.addMessage(sessionId, {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "event",
      role,
      text,
    });
  }

  addLog(sessionId: string, message: string, visible = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const normalizedMessage = truncateText(message, MAX_SESSION_LOG_CHARS);
    session.logs.push(normalizedMessage);
    if (session.logs.length > MAX_SESSION_LOG_ENTRIES) {
      session.logs.splice(0, session.logs.length - MAX_SESSION_LOG_ENTRIES);
    }
    session.updatedAt = Date.now();
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "log",
      sessionId,
      message: normalizedMessage,
      timestamp: Date.now(),
    });
    if (visible) {
      this.addBehavior(sessionId, normalizedMessage, "assistant");
    }
  }

  emitAgentEvent(sessionId: string, event: Record<string, unknown>) {
    this.persistAgentMessage(sessionId, event);
    this.emitEvent({
      type: "agent:event",
      sessionId,
      event,
      timestamp: Date.now(),
    });
  }

  dequeuePendingMessage(
    sessionId: string,
  ): string | PendingUserMessage | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    ensureWorkflowProgress(session);
    const next = session.pendingUserMessages.shift();
    session.updatedAt = Date.now();
    this.persistence.persistSnapshot(session);
    return next;
  }

  setWorkflowMeta(
    sessionId: string,
    patch: Partial<
      Pick<WorkflowProgress, "detail" | "iteration" | "maxIterations">
    >,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.setWorkflowMeta(session, patch);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress },
      timestamp: Date.now(),
    });
  }

  startWorkflowNode(
    sessionId: string,
    node: WorkflowNodeKey,
    options?: {
      detail?: string;
      iteration?: number;
      maxIterations?: number;
    },
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.startWorkflowNode(session, node, options);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress },
      timestamp: Date.now(),
    });
  }

  completeWorkflowNode(
    sessionId: string,
    node: WorkflowNodeKey,
    detail?: string,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.completeWorkflowNode(session, node, detail);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress },
      timestamp: Date.now(),
    });
  }

  failWorkflowNode(sessionId: string, node: WorkflowNodeKey, error: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.failWorkflowNode(session, node, error);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress },
      timestamp: Date.now(),
    });
  }

  addWorkflowArchive(sessionId: string, entry: WorkflowArchiveEntry) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const result = mutateSession.addWorkflowArchive(session, entry);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { result },
      timestamp: Date.now(),
    });
  }

  startStep(sessionId: string, step: PipelineStep) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const { hasExecutionStarted } = mutateSession.startStep(session, step);
    if (!hasExecutionStarted) {
      this.addBehavior(sessionId, "启动执行");
    }
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "step:start",
      sessionId,
      step,
      timestamp: Date.now(),
    });
  }

  completeStep(
    sessionId: string,
    step: PipelineStep,
    data?: Record<string, unknown>,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    mutateSession.completeStep(session, step, data);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "step:complete",
      sessionId,
      step,
      data,
      timestamp: Date.now(),
    });
  }

  failStep(sessionId: string, step: PipelineStep, error: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    mutateSession.failStep(session, step, error);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "step:error",
      sessionId,
      step,
      message: error,
      timestamp: Date.now(),
    });
  }

  markQueued(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.markQueued(session);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress, status: "queued" },
      timestamp: Date.now(),
    });
  }

  updateQueuePosition(sessionId: string, position: number, total: number) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.updateQueuePosition(
      session,
      position,
      total,
    );
    if (!progress) return;
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress, status: "queued" },
      timestamp: Date.now(),
    });
  }

  completePipeline(
    sessionId: string,
    options?: {
      detail?: string;
      status?: "completed";
    },
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.completePipeline(session, options);
    this.addBehavior(sessionId, "执行完成");
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: { progress, status: session.status },
      timestamp: Date.now(),
    });
    this.emitEvent({
      type: "pipeline:complete",
      sessionId,
      timestamp: Date.now(),
    });
  }

  failPipeline(sessionId: string, error: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const progress = mutateSession.failPipeline(session, error);
    this.addBehavior(sessionId, `执行失败${error ? `：${error}` : ""}`);
    this.persistence.persistSnapshot(session);
    this.emitEvent({
      type: "session:updated",
      sessionId,
      data: {
        activeStep: session.activeStep,
        error,
        progress,
        status: "failed",
        steps: session.steps,
      },
      timestamp: Date.now(),
    });
    this.emitEvent({
      type: "pipeline:error",
      sessionId,
      message: error,
      timestamp: Date.now(),
    });
  }

  private emitEvent(event: SessionEvent) {
    emitSessionEvent(this, this.sessions, this.persistence, event);
  }
}

const sessionStore = new SessionStore();

export type {
  PipelineStep,
  Session,
  SessionEvent,
  SessionMessage,
  SessionPersistenceState,
  SessionResult,
  SessionStatus,
  WorkflowArchiveEntry,
  WorkflowArchiveItem,
  WorkflowArchiveStage,
  WorkflowNodeKey,
  WorkflowProgress,
} from "./session-store/types.js";
export { sessionStore };
