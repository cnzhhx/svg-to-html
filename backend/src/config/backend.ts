import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

const repoRoot = () => path.resolve(process.cwd(), "..");

const parseEnvValue = (raw: string) => {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const loadRootEnvFile = () => {
  const envPath = path.join(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(trimmed.slice(equalsIndex + 1));
  }
};

loadRootEnvFile();

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

const readBackendEnvString = (envName: string) =>
  trimToUndefined(process.env[envName]);

const readTruthyFlag = (envName: string, fallback = false) => {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  return parseBooleanString(raw) ?? fallback;
};

const readNumber = (envName: string, fallback: number) => {
  const raw = process.env[envName];
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readNonNegativeNumber = (envName: string, fallback: number) =>
  Math.max(0, readNumber(envName, fallback));

const readPositiveNumber = (envName: string, fallback: number) => {
  const parsed = readNumber(envName, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveRepoRelativePath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(repoRoot(), value);

const buildBackendConfig = () => {
  const nodeEnv = readBackendEnvString("NODE_ENV") ?? "development";
  const maxParallelModuleAgents = readNumber("MAX_PARALLEL_MODULE_AGENTS", 5);

  return {
    agent: {
      maxConcurrentAgents: readNumber("MAX_CONCURRENT_AGENTS", 2),
      maxParallelModuleAgents,
      semanticVisionConcurrency: readNumber(
        "SEMANTIC_VISION_CONCURRENCY",
        Math.min(readNumber("MAX_PARALLEL_MODULE_AGENTS", 10), 3),
      ),
      moduleTimeoutMs: readNumber("MODULE_AGENT_TIMEOUT_MS", 3_600_000),
      moduleCoordinatorEnabled: readTruthyFlag(
        "MODULE_AGENT_COORDINATOR_ENABLED",
        true,
      ),
      moduleCoordinatorNodeThreshold: readNonNegativeNumber(
        "MODULE_AGENT_COORDINATOR_NODE_THRESHOLD",
        50,
      ),
      moduleCoordinatorJsonBytes: readNonNegativeNumber(
        "MODULE_AGENT_COORDINATOR_JSON_BYTES",
        35 * 1024,
      ),
    },
    browser: {
      browserPath: readBackendEnvString("BROWSER_PATH"),
      cdpOperationConcurrency: readPositiveNumber(
        "CDP_OPERATION_CONCURRENCY",
        1,
      ),
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
        "high",
      ),
    },
    runtime: {
      opencodeCliPath: readBackendEnvString("OPENCODE_CLI_PATH") ?? "opencode",
    },
    server: {
      nodeEnv,
      port: readNumber("PORT", 80),
      workspace: resolveRepoRelativePath(
        readBackendEnvString("WORKSPACE") ?? "workspace",
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

export {
  getBackendConfig,
  parseReasoningEffort,
  readBackendEnvString,
};
export type {
  AgentReasoningEffort,
  BackendConfig,
};
