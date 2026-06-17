#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

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

const addCommandCheck = (label, command, required = true) => {
  const version = commandVersion(command);
  checks.push({
    detail: version || `${command} not found`,
    label,
    ok: Boolean(version),
    required,
  });
};

addCommandCheck("Node", "node");
addCommandCheck("pnpm", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
addCommandCheck("opencode", "opencode", false);

const browserCandidates = [
  process.env.CHROMIUM_PATH,
  process.env.CHROME_PATH,
  process.env.BROWSER_PATH,
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "microsoft-edge",
  "microsoft-edge-stable",
].filter(Boolean);

let browser = null;
for (const candidate of browserCandidates) {
  if (candidate.includes("/") || candidate.includes("\\")) {
    try {
      await access(candidate, constants.X_OK);
      browser = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (commandVersion(candidate, ["--version"])) {
    browser = candidate;
    break;
  }
}

checks.push({
  detail:
    browser ||
    "Chrome/Chromium not found; visual verification will fail until configured",
  label: "Browser",
  ok: Boolean(browser),
  required: false,
});

try {
  await access(join(rootDir, "dist/browser-mcp-server.mjs"), constants.R_OK);
  checks.push({
    detail: "dist/browser-mcp-server.mjs",
    label: "MCP build",
    ok: true,
    required: false,
  });
} catch {
  checks.push({
    detail: "run pnpm run build:mcp",
    label: "MCP build",
    ok: false,
    required: false,
  });
}

let failed = false;
for (const check of checks) {
  const marker = check.ok ? "ok" : check.required ? "missing" : "warn";
  console.log(`[doctor] ${marker}: ${check.label} - ${check.detail}`);
  if (!check.ok && check.required) failed = true;
}

if (failed) process.exit(1);
