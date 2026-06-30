import { resolveModelConfigForRole } from "../../config/model-provider.js";
import type { ModelProviderConfig } from "../../config/model-provider.js";
import { createOpencodeRuntime } from "./opencode-runtime.js";
import type { AgentRuntime } from "./types.js";

const createAgentRuntime = (
  modelConfig: ModelProviderConfig = resolveModelConfigForRole("text"),
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
    modelConfig.apiKey,
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
    modelConfig.thinking,
  ].join("::");

const getAgentRuntime = (
  modelConfig: ModelProviderConfig = resolveModelConfigForRole("text"),
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
  AgentRunStreamedResult,
  AgentThread,
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurn,
  AgentTurnMetrics,
  ThreadOptions,
  Usage,
} from "./types.js";
