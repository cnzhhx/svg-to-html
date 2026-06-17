import { TEXT_MODEL_CONFIG } from "../../config/model-provider.js";
import type { ModelProviderConfig } from "../../config/model-provider.js";
import { createOpencodeRuntime } from "./opencode-runtime.js";
import type { AgentRuntime } from "./types.js";

const createAgentRuntime = (
  modelConfig: ModelProviderConfig = TEXT_MODEL_CONFIG,
): AgentRuntime => {
  if (modelConfig.runtime !== "opencode") {
    throw new Error(
      `Unsupported runtime "${modelConfig.runtime}". Only opencode is supported.`,
    );
  }
  return createOpencodeRuntime(modelConfig);
};

const runtimeCache = new Map<string, AgentRuntime>();

const getRuntimeCacheKey = (modelConfig: ModelProviderConfig) =>
  [
    modelConfig.id,
    modelConfig.runtime,
    modelConfig.wireApi,
    modelConfig.provider ?? "",
    modelConfig.providerLabel,
    modelConfig.model,
    modelConfig.baseURL,
    modelConfig.cliModel ?? "",
    modelConfig.contextWindow ?? "",
    modelConfig.maxOutputTokens ?? "",
    JSON.stringify(modelConfig.headers),
    JSON.stringify(modelConfig.modalities ?? null),
    modelConfig.reasoningEffort,
    modelConfig.runtimeTrace,
    modelConfig.runtimeTraceSampleChars,
  ].join("::");

const getAgentRuntime = (
  modelConfig: ModelProviderConfig = TEXT_MODEL_CONFIG,
) => {
  const cacheKey = getRuntimeCacheKey(modelConfig);
  const cached = runtimeCache.get(cacheKey);
  if (cached) return cached;
  const runtime = createAgentRuntime(modelConfig);
  runtimeCache.set(cacheKey, runtime);
  return runtime;
};

export { getAgentRuntime };
export type {
  AgentInput,
  AgentRuntime,
  AgentRunStreamedResult,
  AgentThread,
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurn,
  AgentTurnMetrics,
  ThreadOptions,
  Usage,
} from "./types.js";
