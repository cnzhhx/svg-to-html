import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type BackendConfigFieldType = "boolean" | "number" | "string";
type BackendSettingValue = boolean | number | string;
type BackendConfigSource = "default" | "env" | "frontend";

type BackendConfigFieldDefinition = {
  configKey: string;
  defaultValue?: boolean | number | string | null;
  description: string;
  envName: string;
  options?: string[];
  restartRequired?: boolean;
  section: string;
  sensitive?: boolean;
  type: BackendConfigFieldType;
};

type FrontendRuntimeSettings = Record<string, BackendSettingValue>;

type FrontendSettingsField = BackendConfigFieldDefinition & {
  configured: boolean;
  hasFrontendOverride: boolean;
  source: BackendConfigSource;
  value: BackendSettingValue | null;
};

type FrontendSettingsResponse = {
  enabled: boolean;
  fields: FrontendSettingsField[];
};

type AgentReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const SUPPORTED_REASONING_EFFORTS: AgentReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const MODEL_WIRE_APIS = ["anthropic", "chat-completions", "responses"];
const MASKED_SECRET_VALUE = "********";
const FRONTEND_SETTINGS_ENV_NAME = "FRONTEND_SETTINGS_ENABLED";
const runtimeSettingsStorage =
  new AsyncLocalStorage<FrontendRuntimeSettings>();
const sessionRuntimeSettings = new Map<string, FrontendRuntimeSettings>();

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const isTruthyFlag = (raw: string | undefined) => {
  if (raw === undefined || raw === "") return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
};

const parseBooleanString = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
};

const parseReasoningEffort = (
  value: string | undefined,
  fallback: AgentReasoningEffort,
): AgentReasoningEffort => {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized &&
    SUPPORTED_REASONING_EFFORTS.includes(normalized as AgentReasoningEffort)
  ) {
    return normalized as AgentReasoningEffort;
  }
  return fallback;
};

const readFrontendSettingsEnabled = () =>
  isTruthyFlag(process.env[FRONTEND_SETTINGS_ENV_NAME]);

const getActiveRuntimeSettings = () => {
  if (!readFrontendSettingsEnabled()) return {};
  return runtimeSettingsStorage.getStore() ?? {};
};

const getFrontendSettingValue = (envName: string) => {
  if (envName === FRONTEND_SETTINGS_ENV_NAME) return undefined;
  return getActiveRuntimeSettings()[envName];
};

const readMergedRawValue = (envName: string) => {
  const frontendValue = getFrontendSettingValue(envName);
  if (frontendValue !== undefined) return String(frontendValue);
  return process.env[envName];
};

const readBackendEnvString = (envName: string) =>
  trimToUndefined(readMergedRawValue(envName));

const readTruthyFlag = (envName: string, fallback = false) => {
  const raw = readMergedRawValue(envName);
  if (raw === undefined || raw === "") return fallback;
  return parseBooleanString(raw) ?? fallback;
};

const readNumber = (envName: string, fallback: number) => {
  const raw = readMergedRawValue(envName);
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readNonNegativeNumber = (envName: string, fallback: number) =>
  Math.max(0, readNumber(envName, fallback));

const readPositiveNumber = (envName: string, fallback: number) => {
  const parsed = readNumber(envName, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildBackendConfig = () => {
  const nodeEnv = readBackendEnvString("NODE_ENV") ?? "development";
  const maxParallelModuleAgents = readNumber("MAX_PARALLEL_MODULE_AGENTS", 5);

  return {
    agent: {
      maxConcurrentAgents: readNumber(
        "MAX_CONCURRENT_AGENTS",
        nodeEnv === "production" ? 1 : 2,
      ),
      maxParallelModuleAgents,
      semanticVisionConcurrency: readNumber(
        "SEMANTIC_VISION_CONCURRENCY",
        Math.min(readNumber("MAX_PARALLEL_MODULE_AGENTS", 10), 3),
      ),
      verifyRollbackThreshold: readNumber(
        "AGENT_VERIFY_ROLLBACK_THRESHOLD",
        0.005,
      ),
      moduleTimeoutMs: readNumber("MODULE_AGENT_TIMEOUT_MS", 3_600_000),
    },
    browser: {
      browserPath: readBackendEnvString("BROWSER_PATH"),
      browserPoolDisabled: readTruthyFlag("BROWSER_POOL_DISABLED"),
      browserPoolIdleMs: readNumber("BROWSER_POOL_IDLE_MS", 1000),
      cdpReadyTimeoutMs: readNumber("CDP_READY_TIMEOUT_MS", 60_000),
      cdpSendTimeoutMs: readNumber("CDP_SEND_TIMEOUT_MS", 120_000),
      chromePath: readBackendEnvString("CHROME_PATH"),
      chromiumPath: readBackendEnvString("CHROMIUM_PATH"),
      staticServerPoolDisabled: readTruthyFlag("STATIC_SERVER_POOL_DISABLED"),
      staticServerPoolIdleMs: readNumber("STATIC_SERVER_POOL_IDLE_MS", 1000),
    },
    diff: {
      diffRatioThreshold: readNumber("DIFF_RATIO_THRESHOLD", 0.05),
      moduleDiffRatioThreshold: readNumber("MODULE_DIFF_RATIO_THRESHOLD", 0.05),
      pngRasterScaleMultiplier: readPositiveNumber(
        "PNG_RASTER_SCALE_MULTIPLIER",
        2,
      ),
    },
    frontend: {
      settingsEnabled: readFrontendSettingsEnabled(),
    },
    logging: {
      maxAgentEventOutputChars: readNumber(
        "SESSION_AGENT_EVENT_OUTPUT_MAX_CHARS",
        100,
      ),
      maxAgentReasoningEventChars: readNumber(
        "SESSION_AGENT_REASONING_EVENT_MAX_CHARS",
        4000,
      ),
      maxAgentStdoutLogChars: readNumber("SESSION_AGENT_STDOUT_LOG_CHARS", 100),
      maxAgentStdoutLogLineChars: readNumber(
        "SESSION_AGENT_STDOUT_LOG_LINE_CHARS",
        100,
      ),
      maxAgentStdoutLogLines: readNumber("SESSION_AGENT_STDOUT_LOG_LINES", 20),
      maxEventCommandChars: readNonNegativeNumber(
        "SESSION_EVENT_COMMAND_CHARS",
        100,
      ),
      maxEventCommandOutputChars: readNonNegativeNumber(
        "SESSION_EVENT_COMMAND_OUTPUT_CHARS",
        100,
      ),
      maxEventMetricChunkGaps: readNonNegativeNumber(
        "SESSION_EVENT_METRIC_CHUNK_GAPS",
        20,
      ),
      maxEventMetricThinkSamples: readNonNegativeNumber(
        "SESSION_EVENT_METRIC_THINK_SAMPLES",
        0,
      ),
      maxEventReasoningChars: readNonNegativeNumber(
        "SESSION_EVENT_REASONING_CHARS",
        4_000,
      ),
      maxEventToolTextChars: readNonNegativeNumber(
        "SESSION_EVENT_TOOL_TEXT_CHARS",
        100,
      ),
      maxModelTelemetryRecords: readNonNegativeNumber(
        "SESSION_MODEL_TELEMETRY_RECORDS",
        200,
      ),
      maxSessionLogChars: readNumber("SESSION_LOG_MAX_CHARS", 12000),
      maxSessionLogEntries: readNumber("SESSION_LOG_MAX_ENTRIES", 500),
    },
    modelProvider: {
      configPath: path.resolve(process.cwd(), "config/model-provider.json"),
    },
    reasoning: {
      agentUnit: parseReasoningEffort(
        readBackendEnvString("AGENT_UNIT_REASONING_EFFORT"),
        "high",
      ),
      default: parseReasoningEffort(
        readBackendEnvString("DEFAULT_AGENT_REASONING_EFFORT"),
        "high",
      ),
      support: parseReasoningEffort(
        readBackendEnvString("SUPPORT_AGENT_REASONING_EFFORT"),
        "none",
      ),
    },
    runtime: {
      opencodeCliPath: readBackendEnvString("OPENCODE_CLI_PATH") ?? "opencode",
    },
    server: {
      nodeEnv,
      port: readNumber("PORT", 80),
      workspace: path.resolve(
        readBackendEnvString("WORKSPACE") ??
          path.join(process.cwd(), "workspace"),
      ),
    },
    session: {
      agentMessageSampleChars: readNonNegativeNumber(
        "SESSION_AGENT_MESSAGE_SAMPLE_CHARS",
        100,
      ),
      agentReasoningMessageChars: readNonNegativeNumber(
        "SESSION_AGENT_REASONING_MESSAGE_CHARS",
        4_000,
      ),
      archiveCommandOutputMaxChars: readNonNegativeNumber(
        "ARCHIVE_COMMAND_OUTPUT_MAX_CHARS",
        5000,
      ),
      chatDisabled: readTruthyFlag("SESSION_CHAT_DISABLED", true),
      deleteDisabled: readTruthyFlag("SESSION_DELETE_DISABLED"),
      localStorageEnabled: readTruthyFlag("SESSION_LOCAL_STORAGE_ENABLED"),
      visionTextTimeoutMs: readNumber("VISION_TEXT_TIMEOUT_MS", 300_000),
    },
    workflow: {
      archiveFullEveryN: readNumber("WORKFLOW_ARCHIVE_FULL_EVERY_N", 5),
      archiveTextMaxChars: readNumber("WORKFLOW_ARCHIVE_TEXT_MAX_CHARS", 12000),
      modelPlannerMockResponse: readBackendEnvString(
        "MODEL_PLANNER_MOCK_RESPONSE",
      ),
      modelPlannerTurnTimeoutMs: readNumber(
        "MODEL_PLANNER_TURN_TIMEOUT_MS",
        600_000,
      ),
    },
  } as const;
};

type BackendConfig = ReturnType<typeof buildBackendConfig>;

const getBackendConfig = () => buildBackendConfig();
const BACKEND_CONFIG: BackendConfig = buildBackendConfig();

const makeField = (
  field: BackendConfigFieldDefinition,
): BackendConfigFieldDefinition => field;

const MODEL_FIELD_DEFINITIONS: BackendConfigFieldDefinition[] = [
  makeField({
    configKey: "model.global.configId",
    defaultValue: null,
    description: "选择模型配置 ID；未设置角色专属模型时对所有角色生效。",
    envName: "MODEL_CONFIG_ID",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.provider",
    defaultValue: null,
    description: "模型提供商标识，用于选择模型配置。",
    envName: "MODEL_PROVIDER",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.providerName",
    defaultValue: null,
    description: "模型提供商显示名称，用于日志和错误提示。",
    envName: "MODEL_PROVIDER_NAME",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.apiKey",
    defaultValue: null,
    description: "当前模型渠道使用的 API Key。",
    envName: "MODEL_API_KEY",
    section: "model",
    sensitive: true,
    type: "string",
  }),
  makeField({
    configKey: "model.global.baseURL",
    defaultValue: null,
    description: "模型服务 API 地址。",
    envName: "MODEL_BASE_URL",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.model",
    defaultValue: null,
    description: "模型服务中的模型名称。",
    envName: "MODEL_ID",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.cliModel",
    defaultValue: null,
    description: "传给 opencode CLI 的可选模型引用。",
    envName: "MODEL_CLI_ID",
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.wireApi",
    defaultValue: "chat-completions",
    description: "调用模型服务时使用的协议格式。",
    envName: "MODEL_WIRE_API",
    options: MODEL_WIRE_APIS,
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.reasoningEffort",
    defaultValue: null,
    description: "模型运行时使用的推理强度。",
    envName: "MODEL_REASONING_EFFORT",
    options: SUPPORTED_REASONING_EFFORTS,
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.runtime",
    defaultValue: "opencode",
    description: "执行模型调用的运行时适配器。",
    envName: "MODEL_RUNTIME",
    options: ["opencode"],
    section: "model",
    type: "string",
  }),
  makeField({
    configKey: "model.global.maxOutputTokens",
    defaultValue: null,
    description: "模型回复的最大输出 token 数；留空不限制。",
    envName: "MODEL_MAX_OUTPUT_TOKENS",
    section: "model",
    type: "number",
  }),
  makeField({
    configKey: "model.global.contextWindow",
    defaultValue: null,
    description: "模型上下文窗口大小；留空使用后端默认。",
    envName: "MODEL_CONTEXT_WINDOW",
    section: "model",
    type: "number",
  }),
  makeField({
    configKey: "model.global.thinking",
    defaultValue: null,
    description: "模型支持时启用 thinking 输出。",
    envName: "MODEL_THINKING",
    section: "model",
    type: "boolean",
  }),
  makeField({
    configKey: "model.global.runtimeTrace",
    defaultValue: true,
    description: "是否写入模型调用 trace 日志。",
    envName: "MODEL_RUNTIME_TRACE",
    section: "model",
    type: "boolean",
  }),
  makeField({
    configKey: "model.global.runtimeTraceSampleChars",
    defaultValue: 100,
    description: "模型 trace 日志最多采样的字符数。",
    envName: "MODEL_RUNTIME_TRACE_SAMPLE_CHARS",
    section: "model",
    type: "number",
  }),
];

const roleModelFields = (
  role: "moduleAgent" | "text" | "vision",
  prefix: "MODULE_AGENT" | "TEXT" | "VISION",
  label: string,
) =>
  MODEL_FIELD_DEFINITIONS.map((field) => ({
    ...field,
    configKey: field.configKey.replace("model.global", `model.${role}`),
    description: `${label}: ${field.description}`,
    envName: `${prefix}_${field.envName}`,
    section: "model",
  }));

const BACKEND_CONFIG_FIELDS: BackendConfigFieldDefinition[] = [
  {
    configKey: "frontend.settingsEnabled",
    defaultValue: false,
    description:
      "是否展示前端设置入口，并允许执行时的前端参数覆盖后端 env。",
    envName: FRONTEND_SETTINGS_ENV_NAME,
    section: "frontend",
    type: "boolean",
  },
  {
    configKey: "server.port",
    defaultValue: 80,
    description: "Express 服务监听端口。",
    envName: "PORT",
    restartRequired: true,
    section: "server",
    type: "number",
  },
  {
    configKey: "server.workspace",
    defaultValue: "./workspace",
    description: "session、产物、日志和运行数据的根目录。",
    envName: "WORKSPACE",
    restartRequired: true,
    section: "server",
    type: "string",
  },
  {
    configKey: "server.nodeEnv",
    defaultValue: "development",
    description: "运行环境，会影响部分默认值，例如 session 并发。",
    envName: "NODE_ENV",
    restartRequired: true,
    section: "server",
    type: "string",
  },
  {
    configKey: "agent.maxConcurrentAgents",
    defaultValue: "production=1, development=2",
    description: "最多同时执行的 session 数量。",
    envName: "MAX_CONCURRENT_AGENTS",
    section: "agent",
    type: "number",
  },
  {
    configKey: "agent.maxParallelModuleAgents",
    defaultValue: 5,
    description: "单个 session 内最多同时运行的模块 agent 数量。",
    envName: "MAX_PARALLEL_MODULE_AGENTS",
    section: "agent",
    type: "number",
  },
  {
    configKey: "agent.semanticVisionConcurrency",
    defaultValue: "min(MAX_PARALLEL_MODULE_AGENTS, 3)",
    description: "共享视觉模型语义分析的并发上限。",
    envName: "SEMANTIC_VISION_CONCURRENCY",
    section: "agent",
    type: "number",
  },
  {
    configKey: "agent.moduleTimeoutMs",
    defaultValue: 3_600_000,
    description: "单个模块 agent 回合最长执行时间，单位毫秒。",
    envName: "MODULE_AGENT_TIMEOUT_MS",
    section: "agent",
    type: "number",
  },
  {
    configKey: "agent.verifyRollbackThreshold",
    defaultValue: 0.005,
    description: "diffRatio 反弹超过此值时触发回滚逻辑。",
    envName: "AGENT_VERIFY_ROLLBACK_THRESHOLD",
    section: "agent",
    type: "number",
  },
  {
    configKey: "agent.defaultReasoningEffort",
    defaultValue: "high",
    description: "模块 agent 默认使用的推理强度。",
    envName: "DEFAULT_AGENT_REASONING_EFFORT",
    options: SUPPORTED_REASONING_EFFORTS,
    section: "agent",
    type: "string",
  },
  {
    configKey: "agent.unitReasoningEffort",
    defaultValue: "high",
    description: "单个模块 agent 回合使用的推理强度。",
    envName: "AGENT_UNIT_REASONING_EFFORT",
    options: SUPPORTED_REASONING_EFFORTS,
    section: "agent",
    type: "string",
  },
  {
    configKey: "agent.supportReasoningEffort",
    defaultValue: "none",
    description: "辅助、规划和视觉调用使用的推理强度。",
    envName: "SUPPORT_AGENT_REASONING_EFFORT",
    options: SUPPORTED_REASONING_EFFORTS,
    section: "agent",
    type: "string",
  },
  {
    configKey: "diff.diffRatioThreshold",
    defaultValue: 0.05,
    description: "整页 verify 通过的 diffRatio 阈值。",
    envName: "DIFF_RATIO_THRESHOLD",
    section: "diff",
    type: "number",
  },
  {
    configKey: "diff.moduleDiffRatioThreshold",
    defaultValue: 0.05,
    description: "单模块 verify 通过的 diffRatio 阈值。",
    envName: "MODULE_DIFF_RATIO_THRESHOLD",
    section: "diff",
    type: "number",
  },
  {
    configKey: "diff.pngRasterScaleMultiplier",
    defaultValue: 2,
    description: "导出 PNG 节点资产时额外应用的栅格倍率。",
    envName: "PNG_RASTER_SCALE_MULTIPLIER",
    section: "diff",
    type: "number",
  },
  {
    configKey: "session.localStorageEnabled",
    defaultValue: false,
    description: "是否允许前端把 session 元数据和产物缓存到浏览器本地。",
    envName: "SESSION_LOCAL_STORAGE_ENABLED",
    section: "session",
    type: "boolean",
  },
  {
    configKey: "session.deleteDisabled",
    defaultValue: false,
    description: "是否禁用 session 删除功能。",
    envName: "SESSION_DELETE_DISABLED",
    section: "session",
    type: "boolean",
  },
  {
    configKey: "session.chatDisabled",
    defaultValue: true,
    description: "是否禁用聊天式修复功能。",
    envName: "SESSION_CHAT_DISABLED",
    section: "session",
    type: "boolean",
  },
  {
    configKey: "session.visionTextTimeoutMs",
    defaultValue: 300_000,
    description: "视觉文字识别超时时间，单位毫秒。",
    envName: "VISION_TEXT_TIMEOUT_MS",
    section: "session",
    type: "number",
  },
  {
    configKey: "session.agentMessageSampleChars",
    defaultValue: 100,
    description: "session 聊天里 agent 事件消息最多采样的字符数。",
    envName: "SESSION_AGENT_MESSAGE_SAMPLE_CHARS",
    section: "session",
    type: "number",
  },
  {
    configKey: "session.agentReasoningMessageChars",
    defaultValue: 4_000,
    description: "session 消息中最多保留的推理文本字符数。",
    envName: "SESSION_AGENT_REASONING_MESSAGE_CHARS",
    section: "session",
    type: "number",
  },
  {
    configKey: "session.archiveCommandOutputMaxChars",
    defaultValue: 5000,
    description: "工作流归档 checkpoint 中最多保存的命令输出字符数。",
    envName: "ARCHIVE_COMMAND_OUTPUT_MAX_CHARS",
    section: "session",
    type: "number",
  },
  {
    configKey: "logging.maxSessionLogChars",
    defaultValue: 12000,
    description: "单条 session 日志最多保留的字符数。",
    envName: "SESSION_LOG_MAX_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxSessionLogEntries",
    defaultValue: 500,
    description: "每个 session 最多保留的日志条目数。",
    envName: "SESSION_LOG_MAX_ENTRIES",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxAgentEventOutputChars",
    defaultValue: 100,
    description: "推送到前端的 agent 事件输出最多保留的字符数。",
    envName: "SESSION_AGENT_EVENT_OUTPUT_MAX_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxAgentReasoningEventChars",
    defaultValue: 4000,
    description: "agent 事件中推理内容最多保留的字符数。",
    envName: "SESSION_AGENT_REASONING_EVENT_MAX_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxAgentStdoutLogChars",
    defaultValue: 100,
    description: "写入 session 日志的 stdout 最多采样字符数。",
    envName: "SESSION_AGENT_STDOUT_LOG_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxAgentStdoutLogLines",
    defaultValue: 20,
    description: "写入 session 日志的 stdout 最多采样行数。",
    envName: "SESSION_AGENT_STDOUT_LOG_LINES",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxAgentStdoutLogLineChars",
    defaultValue: 100,
    description: "stdout 单行采样最多保留的字符数。",
    envName: "SESSION_AGENT_STDOUT_LOG_LINE_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxModelTelemetryRecords",
    defaultValue: 200,
    description: "session 结果中最多保留的模型调用遥测记录数。",
    envName: "SESSION_MODEL_TELEMETRY_RECORDS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventCommandOutputChars",
    defaultValue: 100,
    description: "压缩 agent 事件中命令输出最多保留的字符数。",
    envName: "SESSION_EVENT_COMMAND_OUTPUT_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventCommandChars",
    defaultValue: 100,
    description: "压缩 agent 事件中命令本身最多保留的字符数。",
    envName: "SESSION_EVENT_COMMAND_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventToolTextChars",
    defaultValue: 100,
    description: "压缩 agent 事件中工具文本最多保留的字符数。",
    envName: "SESSION_EVENT_TOOL_TEXT_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventReasoningChars",
    defaultValue: 4_000,
    description: "压缩 agent 事件中推理文本最多保留的字符数。",
    envName: "SESSION_EVENT_REASONING_CHARS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventMetricChunkGaps",
    defaultValue: 20,
    description: "每个 agent 回合最多保留的 chunk 间隔指标样本数。",
    envName: "SESSION_EVENT_METRIC_CHUNK_GAPS",
    section: "logging",
    type: "number",
  },
  {
    configKey: "logging.maxEventMetricThinkSamples",
    defaultValue: 0,
    description: "每个 agent 回合最多保留的 thinking 样本数。",
    envName: "SESSION_EVENT_METRIC_THINK_SAMPLES",
    section: "logging",
    type: "number",
  },
  {
    configKey: "browser.chromiumPath",
    defaultValue: null,
    description: "Chromium 可执行文件路径；优先于自动探测。",
    envName: "CHROMIUM_PATH",
    restartRequired: true,
    section: "browser",
    type: "string",
  },
  {
    configKey: "browser.chromePath",
    defaultValue: null,
    description: "Chrome 可执行文件路径；优先于自动探测。",
    envName: "CHROME_PATH",
    restartRequired: true,
    section: "browser",
    type: "string",
  },
  {
    configKey: "browser.browserPath",
    defaultValue: null,
    description: "其他 Chromium 内核浏览器路径；优先于自动探测。",
    envName: "BROWSER_PATH",
    restartRequired: true,
    section: "browser",
    type: "string",
  },
  {
    configKey: "browser.cdpSendTimeoutMs",
    defaultValue: 120_000,
    description: "单个 CDP 命令的最长等待时间。",
    envName: "CDP_SEND_TIMEOUT_MS",
    section: "browser",
    type: "number",
  },
  {
    configKey: "browser.cdpReadyTimeoutMs",
    defaultValue: 60_000,
    description: "等待浏览器调试端口 ready 的最长时间。",
    envName: "CDP_READY_TIMEOUT_MS",
    section: "browser",
    type: "number",
  },
  {
    configKey: "browser.poolIdleMs",
    defaultValue: 1000,
    description: "空闲浏览器进程保留复用的时间。",
    envName: "BROWSER_POOL_IDLE_MS",
    section: "browser",
    type: "number",
  },
  {
    configKey: "browser.poolDisabled",
    defaultValue: false,
    description: "开启后禁用浏览器进程池。",
    envName: "BROWSER_POOL_DISABLED",
    section: "browser",
    type: "boolean",
  },
  {
    configKey: "browser.staticServerPoolIdleMs",
    defaultValue: 1000,
    description: "空闲静态服务器保留复用的时间。",
    envName: "STATIC_SERVER_POOL_IDLE_MS",
    section: "browser",
    type: "number",
  },
  {
    configKey: "browser.staticServerPoolDisabled",
    defaultValue: false,
    description: "开启后禁用静态服务器池。",
    envName: "STATIC_SERVER_POOL_DISABLED",
    section: "browser",
    type: "boolean",
  },
  {
    configKey: "workflow.archiveFullEveryN",
    defaultValue: 5,
    description: "每隔 N 轮写入一次完整工作流归档。",
    envName: "WORKFLOW_ARCHIVE_FULL_EVERY_N",
    section: "workflow",
    type: "number",
  },
  {
    configKey: "workflow.archiveTextMaxChars",
    defaultValue: 12000,
    description: "工作流归档素材中每段文本最多保留的字符数。",
    envName: "WORKFLOW_ARCHIVE_TEXT_MAX_CHARS",
    section: "workflow",
    type: "number",
  },
  {
    configKey: "workflow.modelPlannerTurnTimeoutMs",
    defaultValue: 600_000,
    description: "模型规划器单轮调用的超时时间，单位毫秒。",
    envName: "MODEL_PLANNER_TURN_TIMEOUT_MS",
    section: "workflow",
    type: "number",
  },
  {
    configKey: "workflow.modelPlannerMockResponse",
    defaultValue: null,
    description: "开发调试用模拟响应；填写后跳过真实规划器模型调用。",
    envName: "MODEL_PLANNER_MOCK_RESPONSE",
    section: "workflow",
    type: "string",
  },
  {
    configKey: "runtime.opencodeCliPath",
    defaultValue: "opencode",
    description: "启动 opencode CLI 的命令或绝对路径。",
    envName: "OPENCODE_CLI_PATH",
    restartRequired: true,
    section: "runtime",
    type: "string",
  },
  ...MODEL_FIELD_DEFINITIONS,
  ...roleModelFields("moduleAgent", "MODULE_AGENT", "模块 agent 模型"),
  ...roleModelFields("text", "TEXT", "文本/规划模型"),
  ...roleModelFields("vision", "VISION", "视觉模型"),
];

const NON_RUNTIME_FRONTEND_FIELDS = new Set([
  "agent.maxConcurrentAgents",
  "session.localStorageEnabled",
  "session.deleteDisabled",
  "session.chatDisabled",
]);

const isFrontendRuntimeSettingField = (field: BackendConfigFieldDefinition) =>
  field.envName !== FRONTEND_SETTINGS_ENV_NAME &&
  !field.restartRequired &&
  !NON_RUNTIME_FRONTEND_FIELDS.has(field.configKey);

const fieldByEnvName = new Map(
  BACKEND_CONFIG_FIELDS.map((field) => [field.envName, field]),
);
const fieldByConfigKey = new Map(
  BACKEND_CONFIG_FIELDS.map((field) => [field.configKey, field]),
);

const parseSettingValue = (
  field: BackendConfigFieldDefinition,
  value: unknown,
) => {
  if (value === null || value === undefined || value === "") return null;
  if (field.sensitive && value === MASKED_SECRET_VALUE) return undefined;
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    const parsed = parseBooleanString(String(value));
    if (parsed !== undefined) return parsed;
    throw new Error(`${field.envName} must be a boolean`);
  }
  if (field.type === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`${field.envName} must be a finite number`);
  }
  const parsed = String(value).trim();
  if (field.options?.length && !field.options.includes(parsed)) {
    throw new Error(`${field.envName} must be one of: ${field.options.join(", ")}`);
  }
  return parsed;
};

const resolveSettingField = (key: string) => {
  const field = fieldByEnvName.get(key) ?? fieldByConfigKey.get(key);
  if (!field) throw new Error(`Unsupported setting field: ${key}`);
  if (field.envName === FRONTEND_SETTINGS_ENV_NAME) {
    throw new Error(`${FRONTEND_SETTINGS_ENV_NAME} can only be controlled by env`);
  }
  if (!isFrontendRuntimeSettingField(field)) {
    throw new Error(`${field.envName} cannot be overridden for a single run`);
  }
  return field;
};

const getSettingSource = (
  field: BackendConfigFieldDefinition,
  hasFrontendOverride: boolean,
): BackendConfigSource => {
  if (hasFrontendOverride) return "frontend";
  if (process.env[field.envName] !== undefined && process.env[field.envName] !== "") {
    return "env";
  }
  return "default";
};

const getEffectiveFieldValue = (field: BackendConfigFieldDefinition) => {
  const raw = readMergedRawValue(field.envName);
  if (raw === undefined || raw === "") return null;
  if (field.type === "boolean") return parseBooleanString(raw) ?? null;
  if (field.type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return raw;
};

const toPublicFieldValue = (
  field: BackendConfigFieldDefinition,
  value: BackendSettingValue | null,
) => {
  if (!field.sensitive) return value;
  return value === null || value === "" ? null : MASKED_SECRET_VALUE;
};

const getFrontendSettingsResponse = (): FrontendSettingsResponse => {
  const values = getActiveRuntimeSettings();
  return {
    enabled: readFrontendSettingsEnabled(),
    fields: BACKEND_CONFIG_FIELDS.filter(isFrontendRuntimeSettingField).map((field) => {
      const hasFrontendOverride =
        field.envName !== FRONTEND_SETTINGS_ENV_NAME &&
        readFrontendSettingsEnabled() &&
        values[field.envName] !== undefined;
      const value = getEffectiveFieldValue(field);
      return {
        ...field,
        configured: value !== null,
        hasFrontendOverride,
        source: getSettingSource(field, hasFrontendOverride),
        value: toPublicFieldValue(field, value),
      };
    }),
  };
};

const normalizeSettingsUpdatePayload = (
  payload: unknown,
): Record<string, unknown> => {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return {};
    return normalizeSettingsUpdatePayload(JSON.parse(trimmed));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Settings payload must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const values = record["values"];
  if (values && typeof values === "object" && !Array.isArray(values)) {
    return values as Record<string, unknown>;
  }
  return record;
};

const parseFrontendRuntimeSettings = (
  payload: unknown,
): FrontendRuntimeSettings => {
  if (!readFrontendSettingsEnabled() || payload === undefined || payload === null) {
    return {};
  }
  const rawValues = normalizeSettingsUpdatePayload(payload);
  const settings: FrontendRuntimeSettings = {};

  for (const [key, rawValue] of Object.entries(rawValues)) {
    const field = resolveSettingField(key);
    const parsed = parseSettingValue(field, rawValue);
    if (parsed === undefined) continue;
    if (parsed !== null) settings[field.envName] = parsed;
  }

  return settings;
};

const mergeFrontendRuntimeSettings = (
  ...settingsList: Array<FrontendRuntimeSettings | undefined>
): FrontendRuntimeSettings | undefined => {
  const merged: FrontendRuntimeSettings = {};
  for (const settings of settingsList) {
    if (!settings) continue;
    Object.assign(merged, settings);
  }
  return Object.keys(merged).length ? merged : undefined;
};

const setSessionRuntimeSettings = (
  sessionId: string,
  settings: FrontendRuntimeSettings | undefined,
) => {
  if (!settings || !Object.keys(settings).length) {
    sessionRuntimeSettings.delete(sessionId);
    return;
  }
  sessionRuntimeSettings.set(sessionId, { ...settings });
};

const getSessionRuntimeSettings = (sessionId: string) =>
  sessionRuntimeSettings.get(sessionId);

const getActiveRuntimeSettingsEnv = () =>
  Object.fromEntries(
    Object.entries(getActiveRuntimeSettings()).map(([envName, value]) => [
      envName,
      String(value),
    ]),
  );

const clearSessionRuntimeSettings = (sessionId: string) => {
  sessionRuntimeSettings.delete(sessionId);
};

const withFrontendRuntimeSettings = <T>(
  settings: FrontendRuntimeSettings | undefined,
  callback: () => T,
): T =>
  runtimeSettingsStorage.run(
    readFrontendSettingsEnabled() && settings ? settings : {},
    callback,
  );

const withSessionRuntimeSettings = <T>(
  sessionId: string,
  callback: () => T,
): T => withFrontendRuntimeSettings(getSessionRuntimeSettings(sessionId), callback);

const sanitizeFrontendRuntimeSettingsForApi = (
  settings: FrontendRuntimeSettings | undefined,
) => {
  if (!settings) return undefined;
  const safeEntries = Object.entries(settings)
    .map(([envName, value]) => {
      const field = fieldByEnvName.get(envName);
      if (!field) return null;
      return [
        envName,
        {
          configKey: field.configKey,
          envName,
          value: toPublicFieldValue(field, value),
        },
      ] as const;
    })
    .filter((entry): entry is [string, {
      configKey: string;
      envName: string;
      value: BackendSettingValue | null;
    }] => Boolean(entry));
  return safeEntries.length ? Object.fromEntries(safeEntries) : undefined;
};

export {
  BACKEND_CONFIG,
  BACKEND_CONFIG_FIELDS,
  MASKED_SECRET_VALUE,
  clearSessionRuntimeSettings,
  getBackendConfig,
  getActiveRuntimeSettingsEnv,
  getFrontendSettingsResponse,
  getSessionRuntimeSettings,
  isTruthyFlag,
  mergeFrontendRuntimeSettings,
  parseFrontendRuntimeSettings,
  parseReasoningEffort,
  readBackendEnvString,
  sanitizeFrontendRuntimeSettingsForApi,
  setSessionRuntimeSettings,
  withFrontendRuntimeSettings,
  withSessionRuntimeSettings,
};
export type {
  AgentReasoningEffort,
  BackendConfig,
  BackendConfigFieldDefinition,
  BackendConfigFieldType,
  BackendSettingValue,
  FrontendRuntimeSettings,
  FrontendSettingsResponse,
};
