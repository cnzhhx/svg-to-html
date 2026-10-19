import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
  const envPath = process.env["ENV_FILE"] || path.join(repoRoot(), ".env");
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

const readBackendEnvString = (envName: string) =>
  trimToUndefined(process.env[envName]);

const readNumber = (envName: string, fallback: number) => {
  const parsed = Number(process.env[envName] ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readPositiveInteger = (envName: string, fallback: number) => {
  const parsed = readNumber(envName, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readCsv = (envName: string) =>
  (process.env[envName] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const resolveRepoPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(repoRoot(), value);

const readTimeZone = (envName: string, fallback: string) => {
  const value = readBackendEnvString(envName) ?? fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    throw new Error(`${envName} is not a valid IANA time zone: ${value}`);
  }
};

const readAdminKey = () => {
  const key = readBackendEnvString("SVG_TO_HTML_ADMIN_KEY");
  if (key && key.length < 32) {
    throw new Error("SVG_TO_HTML_ADMIN_KEY must contain at least 32 characters");
  }
  return key;
};

const buildBackendConfig = () =>
  ({
    admin: {
      key: readAdminKey(),
    },
    access: {
      dailyUploadLimit: readPositiveInteger("SVG_TO_HTML_DAILY_UPLOAD_LIMIT", 5),
      statePath: resolveRepoPath(
        readBackendEnvString("SVG_TO_HTML_ACCESS_STATE_PATH") ??
          "workspace/gateway/access-state.json",
      ),
      timeZone: readTimeZone(
        "SVG_TO_HTML_DAILY_QUOTA_TIME_ZONE",
        "Asia/Shanghai",
      ),
      showcaseJobIds: readCsv("SVG_TO_HTML_SHOWCASE_JOB_IDS"),
    },
    limits: {
      maxSvgUploadBytes: 50 * 1024 * 1024,
    },
    queue: {
      estimatedTaskMinutes: readPositiveInteger(
        "SVG_TO_HTML_ESTIMATED_TASK_MINUTES",
        20,
      ),
      maxConcurrentJobs: readPositiveInteger("MAX_CONCURRENT_AGENTS", 2),
    },
    core: {
      modelConfigPath:
        readBackendEnvString("SVG_TRANSFORM_CORE_MODEL_CONFIG") ??
        path.resolve(repoRoot(), "backend/config/model-provider.json"),
      serviceUrl: readBackendEnvString("SVG_TRANSFORM_CORE_URL"),
    },
    server: {
      nodeEnv: readBackendEnvString("NODE_ENV") ?? "development",
      port: readNumber("PORT", 8081),
    },
  }) as const;

type BackendConfig = ReturnType<typeof buildBackendConfig>;

const getBackendConfig = () => buildBackendConfig();

export { getBackendConfig, readBackendEnvString };
export type { BackendConfig };
