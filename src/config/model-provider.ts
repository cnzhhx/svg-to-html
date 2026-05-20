import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AGENT_REASONING_EFFORTS,
  parseReasoningEffort,
} from "./agent-reasoning.js";
import type { AgentReasoningEffort } from "./agent-reasoning.js";

type ModelWireApi = "chat" | "responses";
type ModelRuntime = "codex" | "kimi-cli";

type ModelDefinition = Partial<{
  apiKey: string;
  apiKeyEnv: string;
  baseURL: string;
  cliModel: string;
  headers: Record<string, string>;
  model: string;
  provider: string;
  providerName: string;
  reasoningEffort: AgentReasoningEffort;
  requiresOpenaiAuth: boolean;
  runtime: ModelRuntime;
  wireApi: ModelWireApi;
}>;

type ModelProviderFileConfig = Partial<{
  defaultModel: string;
  models: Record<string, ModelDefinition>;
}>;

type ModelProviderConfig = {
  apiKey: string;
  baseURL: string;
  cliModel?: string;
  headers: Record<string, string>;
  model: string;
  provider: string;
  reasoningEffort: AgentReasoningEffort;
  requiresOpenaiAuth: boolean;
  runtime: ModelRuntime;
  wireApi: ModelWireApi;
};

const MODEL_RUNTIMES: ModelRuntime[] = ["codex", "kimi-cli"];
const MODEL_WIRE_APIS: ModelWireApi[] = ["chat", "responses"];

const MODEL_PROVIDER_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config/model-provider.json",
);

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseBoolean = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
};

const parseModelRuntime = (
  value: string | undefined,
  fallback: ModelRuntime,
) => {
  const candidate = value ?? fallback;
  if (MODEL_RUNTIMES.includes(candidate as ModelRuntime)) {
    return candidate as ModelRuntime;
  }
  throw new Error(
    `Invalid model runtime "${candidate}". Expected one of: ${MODEL_RUNTIMES.join(", ")}.`,
  );
};

const parseModelWireApi = (
  value: string | undefined,
  fallback: ModelWireApi,
) => {
  const candidate = value ?? fallback;
  if (MODEL_WIRE_APIS.includes(candidate as ModelWireApi)) {
    return candidate as ModelWireApi;
  }
  throw new Error(
    `Invalid model wire API "${candidate}". Expected one of: ${MODEL_WIRE_APIS.join(", ")}.`,
  );
};

const normalizeHeaders = (headers: ModelDefinition["headers"]) => {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
};

const readModelProviderConfig = (): ModelProviderFileConfig => {
  if (!existsSync(MODEL_PROVIDER_CONFIG_PATH)) return {};
  const raw = readFileSync(MODEL_PROVIDER_CONFIG_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${MODEL_PROVIDER_CONFIG_PATH} must contain a JSON object`);
  }
  return parsed as ModelProviderFileConfig;
};

const requireConfigValue = ({
  envName,
  configPath,
  provider,
  value,
  valueName,
}: {
  envName: string;
  configPath: string;
  provider: string;
  value: string | undefined;
  valueName: string;
}) => {
  if (value) return value;
  throw new Error(
    `Missing ${valueName} for model provider "${provider}". Set ${envName} or configure it in ${configPath}.`,
  );
};

const resolveModelDefinition = ({
  models,
  requestedModel,
}: {
  models: Record<string, ModelDefinition>;
  requestedModel: string;
}) => {
  const exactMatch = models[requestedModel];
  if (exactMatch)
    return { modelConfigId: requestedModel, modelConfig: exactMatch };

  for (const [modelConfigId, modelConfig] of Object.entries(models)) {
    if (
      trimToUndefined(modelConfig.provider) === requestedModel ||
      trimToUndefined(modelConfig.model) === requestedModel
    ) {
      return { modelConfigId, modelConfig };
    }
  }

  return {
    modelConfigId: requestedModel,
    modelConfig: {
      provider: requestedModel,
      wireApi: "responses",
      requiresOpenaiAuth: false,
    } satisfies ModelDefinition,
  };
};

const fileConfig = readModelProviderConfig();
const models = fileConfig.models ?? {};
const requestedModel =
  trimToUndefined(process.env["MODEL_CONFIG_ID"]) ??
  trimToUndefined(process.env["MODEL_PROVIDER"]) ??
  trimToUndefined(fileConfig.defaultModel) ??
  "codex";
const { modelConfigId, modelConfig } = resolveModelDefinition({
  models,
  requestedModel,
});
const configuredProvider = trimToUndefined(modelConfig.provider) ?? modelConfigId;
const providerApiKeyEnv =
  trimToUndefined(modelConfig.apiKeyEnv) ??
  `${configuredProvider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

const configReasoningEffort = parseReasoningEffort(
  modelConfig.reasoningEffort,
  AGENT_REASONING_EFFORTS.default,
);

const MODEL_CONFIG: ModelProviderConfig = {
  apiKey: requireConfigValue({
    envName: `MODEL_API_KEY, ${providerApiKeyEnv}`,
    configPath: MODEL_PROVIDER_CONFIG_PATH,
    provider: configuredProvider,
    value:
      trimToUndefined(process.env["MODEL_API_KEY"]) ??
      trimToUndefined(process.env[providerApiKeyEnv]) ??
      trimToUndefined(modelConfig.apiKey),
    valueName: "api key",
  }),
  baseURL: requireConfigValue({
    envName: "MODEL_BASE_URL",
    configPath: MODEL_PROVIDER_CONFIG_PATH,
    provider: configuredProvider,
    value:
      trimToUndefined(process.env["MODEL_BASE_URL"]) ??
      trimToUndefined(modelConfig.baseURL),
    valueName: "base URL",
  }),
  cliModel:
    trimToUndefined(process.env["MODEL_CLI_ID"]) ??
    trimToUndefined(modelConfig.cliModel),
  headers: normalizeHeaders(modelConfig.headers),
  model: requireConfigValue({
    envName: "MODEL_ID",
    configPath: MODEL_PROVIDER_CONFIG_PATH,
    provider: configuredProvider,
    value:
      trimToUndefined(process.env["MODEL_ID"]) ??
      trimToUndefined(modelConfig.model),
    valueName: "model id",
  }),
  provider:
    trimToUndefined(process.env["MODEL_PROVIDER_NAME"]) ??
    trimToUndefined(modelConfig.providerName) ??
    configuredProvider,
  reasoningEffort: parseReasoningEffort(
    process.env["MODEL_REASONING_EFFORT"],
    configReasoningEffort,
  ),
  requiresOpenaiAuth:
    parseBoolean(process.env["MODEL_REQUIRES_OPENAI_AUTH"]) ??
    modelConfig.requiresOpenaiAuth ??
    false,
  runtime: parseModelRuntime(
    trimToUndefined(process.env["MODEL_RUNTIME"]),
    modelConfig.runtime ?? "codex",
  ),
  wireApi: parseModelWireApi(
    trimToUndefined(process.env["MODEL_WIRE_API"]),
    modelConfig.wireApi ?? "responses",
  ),
};

if (MODEL_CONFIG.runtime === "codex" && MODEL_CONFIG.wireApi !== "responses") {
  throw new Error(
    `Model config "${modelConfigId}" uses wireApi="${MODEL_CONFIG.wireApi}", but @openai/codex-sdk requires the Responses API for agent threads. Use a Responses-compatible provider as the default model.`,
  );
}

export { MODEL_CONFIG };
export type { ModelProviderConfig, ModelRuntime, ModelWireApi };
