import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ModelConfigRole,
  ModelProviderConfig,
} from "../config/model-provider.js";
import { sessionStore } from "../session-store.js";
import type { AgentTurnMetrics, Usage } from "./agent-runtime/index.js";

type ModelUsageContext = {
  sessionId?: string;
  source?: string;
};

type ModelUsageRecord = {
  cachedInputTokens: number;
  createdAt: number;
  id: string;
  inputKind?: "text" | "vision";
  inputTokens: number;
  modelConfigId: string;
  model: string;
  modelRole?: ModelConfigRole;
  metrics?: AgentTurnMetrics;
  outputTokens: number;
  provider: string;
  runtime: string;
  source?: string;
  threadId?: string | null;
  tokensUsed: number;
  uncachedInputTokens: number;
};

const usageContext = new AsyncLocalStorage<ModelUsageContext>();

const toTokenNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const normalizeUsage = (usage: Usage | null | undefined) => {
  const inputTokens = toTokenNumber(usage?.input_tokens);
  const cachedInputTokens = toTokenNumber(usage?.cached_input_tokens);
  const outputTokens = toTokenNumber(usage?.output_tokens);
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    tokensUsed: inputTokens + outputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
  };
};

const withModelUsageContext = <T>(
  context: ModelUsageContext,
  callback: () => T,
) => usageContext.run({ ...usageContext.getStore(), ...context }, callback);

const recordModelUsage = ({
  inputKind,
  metrics,
  modelConfig,
  modelRole,
  source,
  threadId,
  usage,
}: {
  inputKind?: "text" | "vision";
  metrics?: AgentTurnMetrics;
  modelConfig: Pick<
    ModelProviderConfig,
    "id" | "model" | "providerLabel" | "runtime"
  >;
  modelRole?: ModelConfigRole;
  source?: string;
  threadId?: string | null;
  usage: Usage | null | undefined;
}) => {
  const context = usageContext.getStore();
  const sessionId = context?.sessionId;
  if (!sessionId || !usage) return;

  const normalized = normalizeUsage(usage);
  if (normalized.inputTokens <= 0 && normalized.outputTokens <= 0) return;

  const session = sessionStore.get(sessionId);
  if (!session) return;

  const record: ModelUsageRecord = {
    ...normalized,
    createdAt: Date.now(),
    id: randomUUID(),
    inputKind,
    metrics,
    model: modelConfig.model,
    modelConfigId: modelConfig.id,
    modelRole,
    provider: modelConfig.providerLabel,
    runtime: modelConfig.runtime,
    source: source ?? context.source,
    threadId,
  };
  const previousRecords = Array.isArray(session.result.modelUsageRecords)
    ? session.result.modelUsageRecords
    : [];

  sessionStore.update(sessionId, {
    result: {
      ...session.result,
      cachedInputTokens:
        Number(session.result.cachedInputTokens ?? 0) +
        normalized.cachedInputTokens,
      inputTokens:
        Number(session.result.inputTokens ?? 0) + normalized.inputTokens,
      modelUsageRecords: [...previousRecords, record],
      outputTokens:
        Number(session.result.outputTokens ?? 0) + normalized.outputTokens,
      tokensUsed:
        Number(session.result.tokensUsed ?? 0) + normalized.tokensUsed,
      uncachedInputTokens:
        Number(session.result.uncachedInputTokens ?? 0) +
        normalized.uncachedInputTokens,
    },
  });
};

export { recordModelUsage, withModelUsageContext };
