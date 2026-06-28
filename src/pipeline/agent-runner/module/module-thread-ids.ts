import { sessionStore } from "../../../session-store.js";

const normalizeModuleAgentThreadIds = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, string>;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([moduleId, threadId]) => [
        String(moduleId).trim(),
        typeof threadId === "string" ? threadId.trim() : "",
      ])
      .filter(([moduleId, threadId]) => moduleId && threadId),
  );
};

const readPersistedModuleAgentThreadIds = (sessionId: string) =>
  normalizeModuleAgentThreadIds(
    sessionStore.get(sessionId)?.result.moduleAgentThreadIds,
  );

const persistModuleAgentThreadId = ({
  moduleId,
  sessionId,
  threadId,
}: {
  moduleId: string;
  sessionId: string;
  threadId: string;
}) => {
  const normalizedModuleId = moduleId.trim();
  const normalizedThreadId = threadId.trim();
  if (!normalizedModuleId || !normalizedThreadId) return;
  const current = sessionStore.get(sessionId);
  if (!current) return;
  const nextThreadIds = {
    ...normalizeModuleAgentThreadIds(current.result.moduleAgentThreadIds),
    [normalizedModuleId]: normalizedThreadId,
  };
  sessionStore.update(sessionId, {
    result: {
      ...current.result,
      moduleAgentThreadIds: nextThreadIds,
    },
  });
};

export {
  persistModuleAgentThreadId,
  readPersistedModuleAgentThreadIds,
};
