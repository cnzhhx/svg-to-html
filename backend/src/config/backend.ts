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

const readBackendEnvString = (envName: string) =>
  trimToUndefined(process.env[envName]);

const readNumber = (envName: string, fallback: number) => {
  const parsed = Number(process.env[envName] ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildBackendConfig = () =>
  ({
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
