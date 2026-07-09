#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = resolve(backendDir, "..");

const parseEnvValue = (raw) => {
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
  const envPath = join(rootDir, ".env");
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

const commandVersion = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? "";
};

const checks = [];

const addCheck = (label, ok, detail, required = true) => {
  checks.push({ detail, label, ok, required });
};

const addCommandCheck = (label, command, required = true) => {
  const version = commandVersion(command);
  addCheck(label, Boolean(version), version || `${command} not found`, required);
};

const addPnpmCheck = () => {
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const pnpmVersion = commandVersion(pnpmCommand);
  addCheck("pnpm", Boolean(pnpmVersion), pnpmVersion || "pnpm not found; install with: npm install -g pnpm@10.11.0");
};

loadRootEnvFile();

const resolveRootPath = (value) =>
  isAbsolute(value) ? value : resolve(rootDir, value);

addCommandCheck("Node", "node");
addPnpmCheck();
addCommandCheck("Docker", "docker");

const dockerInfo = spawnSync("docker", ["info"], {
  cwd: rootDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
addCheck(
  "Docker daemon",
  dockerInfo.status === 0,
  dockerInfo.status === 0
    ? "running"
    : (dockerInfo.stderr || dockerInfo.stdout || "docker info failed").trim(),
);

try {
  await access(join(rootDir, "frontend/public/index.html"));
  addCheck("Frontend build", true, "frontend/public/index.html");
} catch {
  addCheck(
    "Frontend build",
    false,
    "not required for pnpm dev; run pnpm -C frontend build for production static preview",
    false,
  );
}

const coreUrl = process.env.SVG_TRANSFORM_CORE_URL?.trim()?.replace(/\/+$/, "");
const coreImage =
  process.env.SVG_TRANSFORM_CORE_IMAGE?.trim() || "ghcr.io/cnzhhx/svg-transform-core:latest";
const coreModelConfig =
  resolveRootPath(
    process.env.SVG_TRANSFORM_CORE_MODEL_CONFIG?.trim() ||
      "backend/config/model-provider.json",
  );
const coreDockerScript = join(rootDir, "scripts/core-docker.sh");
addCheck(
  "Core Docker helper",
  existsSync(coreDockerScript),
  existsSync(coreDockerScript)
    ? coreDockerScript
    : `missing ${coreDockerScript}`,
);
addCheck(
  "Core Docker image",
  Boolean(coreImage),
  coreImage,
);
addCheck(
  "Core model config",
  existsSync(coreModelConfig),
  existsSync(coreModelConfig)
    ? coreModelConfig
    : `missing ${coreModelConfig}; copy backend/config/model-provider.example.json and fill provider credentials`,
);

if (!coreUrl) {
  addCheck(
    "svg-transform-core",
    false,
    "SVG_TRANSFORM_CORE_URL is not configured; expected Docker core URL such as http://127.0.0.1:4310",
  );
} else {
  try {
    const response = await fetch(`${coreUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const text = (await response.text()).trim();
    addCheck(
      "svg-transform-core",
      response.ok && text === "ok",
      `${coreUrl}/health -> ${response.status} ${text || response.statusText}`,
    );
  } catch (error) {
    addCheck(
      "svg-transform-core",
      false,
      `${coreUrl}/health unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let failed = false;
for (const check of checks) {
  const marker = check.ok ? "ok" : check.required ? "missing" : "warn";
  console.log(`[doctor] ${marker}: ${check.label} - ${check.detail}`);
  if (!check.ok && check.required) failed = true;
}

if (failed) process.exit(1);
