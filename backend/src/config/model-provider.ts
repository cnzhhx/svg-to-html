import { existsSync, readFileSync } from "node:fs";

import {
  AGENT_REASONING_EFFORTS,
  parseReasoningEffort,
} from "./agent-reasoning.js";
import type { AgentReasoningEffort } from "./agent-reasoning.js";
import { getBackendConfig, readBackendEnvString } from "./backend.js";

type ModelRuntime = "opencode";
type ModelWireApi = "anthropic" | "chat-completions" | "responses";
type ModelConfigRole = "text" | "vision" | "moduleAgent";

type ModelDefinition = Partial<{
  apiKey: string;
  apiKeyEnv: string;
  baseURL: string;
  cliModel: string;
  contextWindow: number;
  headers: Record<string, string>;
  maxOutputTokens: number;
  modalities: {
    input: string[];
    output: string[];
  };
  model: string;
  provider?: string;
  providerLabel: string;
  providerName: string;
  reasoningEffort: AgentReasoningEffort;
  runtime: ModelRuntime;
  thinking: boolean;
  wireApi: ModelWireApi;
}>;

type ModelProviderFileConfig = Partial<{
  moduleAgentModel: string;
  otherModel: string;
  models: Record<string, ModelDefinition>;
}>;

type ModelProviderConfig = {
  apiKey: string;
  baseURL: string;
  cliModel?: string;
  contextWindow?: number;
  headers: Record<string, string>;
  id: string;
  maxOutputTokens?: number;
  modalities?: {
    input: string[];
    output: string[];
  };
  model: string;
  provider?: string;
  providerLabel: string;
  reasoningEffort: AgentReasoningEffort;
  runtime: ModelRuntime;
  runtimeTrace: boolean;
  runtimeTraceSampleChars: number;
  thinking: boolean;
  wireApi: ModelWireApi;
};

const MODEL_RUNTIMES: ModelRuntime[] = ["opencode"];
const MODEL_WIRE_APIS: ModelWireApi[] = [
  "anthropic",
  "chat-completions",
  "responses",
];
const ROLE_ENV_PREFIX: Record<ModelConfigRole, string> = {
  moduleAgent: "MODULE_AGENT",
  text: "TEXT",
  vision: "VISION",
};

const getModelProviderConfigPath = () => getBackendConfig().modelProvider.configPath;

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

const parseNonNegativeNumber = (
  value: number | string | undefined,
  fallback: number,
) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
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
    `Invalid model runtime "${candidate}". Expected: ${MODEL_RUNTIMES.join(", ")}.`,
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
    `Invalid model wireApi "${candidate}". Expected: ${MODEL_WIRE_APIS.join(", ")}.`,
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

const normalizeModalities = (modalities: ModelDefinition["modalities"]) => {
  if (!modalities) return { input: ["text", "image"], output: ["text"] };
  const normalizeList = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  const input = normalizeList(modalities.input);
  const output = normalizeList(modalities.output);
  return {
    input: input.length ? input : ["text", "image"],
    output: output.length ? output : ["text"],
  };
};

const readModelProviderConfig = (): ModelProviderFileConfig => {
  const configPath = getModelProviderConfigPath();
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
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
  allowInlineModelDefinition = false,
  models,
  requestedModel,
}: {
  allowInlineModelDefinition?: boolean;
  models: Record<string, ModelDefinition>;
  requestedModel: string;
}) => {
  const exactMatch = models[requestedModel];
  if (exactMatch)
    return { modelConfigId: requestedModel, modelConfig: exactMatch };

  for (const [modelConfigId, modelConfig] of Object.entries(models)) {
    if (
      modelConfig.provider === requestedModel ||
      modelConfig.model === requestedModel
    ) {
      return { modelConfigId, modelConfig };
    }
  }

  if (allowInlineModelDefinition) {
    return {
      modelConfigId: requestedModel,
      modelConfig: {
        provider: requestedModel,
      } satisfies ModelDefinition,
    };
  }

  throw new Error(
    `Unknown model config "${requestedModel}". Add it to ${getModelProviderConfigPath()}.`,
  );
};

const getRoleEnvName = (role: ModelConfigRole, envName: string) =>
  `${ROLE_ENV_PREFIX[role]}_${envName}`;

const readRoleEnv = (role: ModelConfigRole, envName: string) =>
  readBackendEnvString(getRoleEnvName(role, envName));

const readRoleAwareEnv = (role: ModelConfigRole, envName: string) =>
  readRoleEnv(role, envName) ?? readBackendEnvString(envName);

const formatRoleAwareEnvNames = (role: ModelConfigRole, envNames: string[]) => {
  const roleEnvNames = envNames.map((envName) => getRoleEnvName(role, envName));
  return [...roleEnvNames, ...envNames].join(", ");
};

const resolveRequestedModel = ({
  fileConfig,
  role,
}: {
  fileConfig: ModelProviderFileConfig;
  role: ModelConfigRole;
}) => {
  const configuredModel =
    role === "moduleAgent"
      ? fileConfig.moduleAgentModel
      : fileConfig.otherModel;
  const inlineModelId = readRoleAwareEnv(role, "MODEL_ID");
  return (
    readRoleAwareEnv(role, "MODEL_CONFIG_ID") ??
    readRoleAwareEnv(role, "MODEL_PROVIDER") ??
    readRoleAwareEnv(role, "MODEL_PROVIDER_NAME") ??
    inlineModelId ??
    trimToUndefined(configuredModel)
  );
};

const getConfiguredModelKey = (role: ModelConfigRole) =>
  role === "moduleAgent" ? "moduleAgentModel" : "otherModel";

const getDefaultThinking = (_role: ModelConfigRole) => true;

const getDefaultReasoningEffort = (role: ModelConfigRole) =>
  role === "moduleAgent"
    ? AGENT_REASONING_EFFORTS.default
    : AGENT_REASONING_EFFORTS.support;

const hasInlineModelDefinition = (role: ModelConfigRole) =>
  Boolean(
    readRoleAwareEnv(role, "MODEL_BASE_URL") &&
      readRoleAwareEnv(role, "MODEL_ID") &&
      readRoleAwareEnv(role, "MODEL_API_KEY"),
  );

const validateModelConfig = ({
  config,
  role,
}: {
  config: ModelProviderConfig;
  role: ModelConfigRole;
}) => {
  if (config.runtime !== "opencode") {
    throw new Error(
      `Model config "${config.id}" for ${role} role uses runtime="${config.runtime}", but only opencode runtime is supported.`,
    );
  }
};

const resolveModelProviderConfig = ({
  fileConfig,
  models,
  role,
}: {
  fileConfig: ModelProviderFileConfig;
  models: Record<string, ModelDefinition>;
  role: ModelConfigRole;
}): ModelProviderConfig => {
  const requestedModel = resolveRequestedModel({ fileConfig, role });
  if (!requestedModel) {
    throw new Error(
      `Missing model config for ${role} role. Set ${getConfiguredModelKey(role)} in ${getModelProviderConfigPath()} or provide ${formatRoleAwareEnvNames(role, ["MODEL_CONFIG_ID", "MODEL_PROVIDER"])}.`,
    );
  }
  const { modelConfigId, modelConfig } = resolveModelDefinition({
    allowInlineModelDefinition: hasInlineModelDefinition(role),
    models,
    requestedModel,
  });
  const configuredProvider = trimToUndefined(modelConfig.provider);
  const providerLabel =
    readRoleAwareEnv(role, "MODEL_PROVIDER_NAME") ??
    trimToUndefined(modelConfig.providerName) ??
    configuredProvider ??
    modelConfigId;
  const providerApiKeyEnv =
    modelConfig.apiKeyEnv ??
    `${providerLabel.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

  const configReasoningEffort = parseReasoningEffort(
    modelConfig.reasoningEffort,
    getDefaultReasoningEffort(role),
  );

  const resolvedMaxOutputTokens = parseNonNegativeNumber(
    readRoleAwareEnv(role, "MODEL_MAX_OUTPUT_TOKENS") ??
      modelConfig.maxOutputTokens,
    0,
  );

  const resolvedContextWindow = parseNonNegativeNumber(
    readRoleAwareEnv(role, "MODEL_CONTEXT_WINDOW") ??
      modelConfig.contextWindow,
    0,
  );

  const resolvedConfig: ModelProviderConfig = {
    apiKey: requireConfigValue({
      envName: `${formatRoleAwareEnvNames(role, ["MODEL_API_KEY"])}, ${providerApiKeyEnv}`,
      configPath: getModelProviderConfigPath(),
      provider: providerLabel,
      value:
        readRoleAwareEnv(role, "MODEL_API_KEY") ??
        readBackendEnvString(providerApiKeyEnv) ??
        trimToUndefined(modelConfig.apiKey),
      valueName: "api key",
    }),
    baseURL: requireConfigValue({
      envName: formatRoleAwareEnvNames(role, ["MODEL_BASE_URL"]),
      configPath: getModelProviderConfigPath(),
      provider: providerLabel,
      value:
        readRoleAwareEnv(role, "MODEL_BASE_URL") ??
        trimToUndefined(modelConfig.baseURL),
      valueName: "base URL",
    }),
    cliModel:
      readRoleAwareEnv(role, "MODEL_CLI_ID") ??
      trimToUndefined(modelConfig.cliModel),
    contextWindow:
      resolvedContextWindow > 0 ? resolvedContextWindow : undefined,
    headers: normalizeHeaders(modelConfig.headers),
    id: modelConfigId,
    maxOutputTokens:
      resolvedMaxOutputTokens > 0 ? resolvedMaxOutputTokens : undefined,
    modalities: normalizeModalities(modelConfig.modalities),
    model: requireConfigValue({
      envName: formatRoleAwareEnvNames(role, ["MODEL_ID"]),
      configPath: getModelProviderConfigPath(),
      provider: providerLabel,
      value:
        readRoleAwareEnv(role, "MODEL_ID") ??
        trimToUndefined(modelConfig.model),
      valueName: "model id",
    }),
    provider: configuredProvider,
    providerLabel,
    reasoningEffort: parseReasoningEffort(
      readRoleAwareEnv(role, "MODEL_REASONING_EFFORT"),
      configReasoningEffort,
    ),
    runtime: parseModelRuntime(
      readRoleAwareEnv(role, "MODEL_RUNTIME"),
      modelConfig.runtime ?? "opencode",
    ),
    runtimeTrace:
      parseBoolean(readRoleAwareEnv(role, "MODEL_RUNTIME_TRACE")) ?? true,
    runtimeTraceSampleChars: parseNonNegativeNumber(
      readRoleAwareEnv(role, "MODEL_RUNTIME_TRACE_SAMPLE_CHARS"),
      100,
    ),
    thinking:
      parseBoolean(readRoleAwareEnv(role, "MODEL_THINKING")) ??
      (typeof modelConfig.thinking === "boolean"
        ? modelConfig.thinking
        : getDefaultThinking(role)),
    wireApi: parseModelWireApi(
      readRoleAwareEnv(role, "MODEL_WIRE_API"),
      modelConfig.wireApi ?? "chat-completions",
    ),
  };

  validateModelConfig({ config: resolvedConfig, role });
  return resolvedConfig;
};

const resolveModelConfigForRole = (role: ModelConfigRole) => {
  const fileConfig = readModelProviderConfig();
  return resolveModelProviderConfig({
    fileConfig,
    models: fileConfig.models ?? {},
    role,
  });
};

export { resolveModelConfigForRole };
export type {
  ModelConfigRole,
  ModelProviderConfig,
};
