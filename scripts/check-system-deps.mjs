#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isPostinstall = process.argv.includes("--postinstall");
const isWindows = process.platform === "win32";

const result = [];

const commandExists = (command) => {
  const pathValue = process.env.PATH ?? "";
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const names = extensions.map((ext) =>
    command.toLowerCase().endsWith(ext.toLowerCase())
      ? command
      : `${command}${ext}`,
  );

  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => names.some((name) => existsSync(path.join(dir, name))));
};

const firstExistingPath = (candidates) =>
  candidates.find((item) => existsSync(item));

const browserCandidates =
  process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : process.platform === "linux"
      ? [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/snap/bin/chromium",
          "/usr/bin/microsoft-edge",
          "/usr/bin/microsoft-edge-stable",
          "/opt/google/chrome/chrome",
        ]
      : isWindows
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [];

const addResult = ({
  detail = "",
  install = "",
  name,
  ok,
  required = true,
}) => {
  result.push({ detail, install, name, ok, required });
};

const readModelRuntime = () => {
  const configPath = path.resolve("config/model-provider.json");
  if (!existsSync(configPath)) return process.env.MODEL_RUNTIME ?? "codex";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const id =
      process.env.MODEL_CONFIG_ID ??
      process.env.MODEL_PROVIDER ??
      config.defaultModel ??
      "codex";
    const model = config.models?.[id];
    return process.env.MODEL_RUNTIME ?? model?.runtime ?? "codex";
  } catch {
    return process.env.MODEL_RUNTIME ?? "codex";
  }
};

const detectTesseractLanguages = () => {
  if (!commandExists("tesseract"))
    return { hasChinese: false, hasEnglish: false };
  try {
    const output = execFileSync("tesseract", ["--list-langs"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      hasChinese: /\bchi_sim\b/.test(output),
      hasEnglish: /\beng\b/.test(output),
    };
  } catch {
    return { hasChinese: false, hasEnglish: false };
  }
};

const configuredBrowser =
  process.env.CHROMIUM_PATH ??
  process.env.CHROME_PATH ??
  process.env.BROWSER_PATH;
const browserPath = configuredBrowser || firstExistingPath(browserCandidates);
addResult({
  detail: browserPath ? `found: ${browserPath}` : "not found",
  install: isWindows
    ? "Install Google Chrome or Microsoft Edge, or set CHROME_PATH/BROWSER_PATH."
    : "Install Chrome/Chromium/Edge, or set CHROME_PATH/BROWSER_PATH.",
  name: "Chromium-compatible browser",
  ok: Boolean(browserPath),
});

const provider =
  process.env.OCR_PROVIDER === "swift-vision" ||
  process.env.OCR_PROVIDER === "tesseract"
    ? process.env.OCR_PROVIDER
    : process.platform === "darwin"
      ? "swift-vision"
      : "tesseract";

if (provider === "swift-vision") {
  const swiftOk =
    existsSync("/usr/bin/swift") ||
    existsSync("/usr/local/swift/usr/bin/swift");
  addResult({
    detail: swiftOk ? "found Swift toolchain" : "Swift toolchain not found",
    install: "Install Xcode Command Line Tools, or set OCR_PROVIDER=tesseract.",
    name: "OCR provider: swift-vision",
    ok: swiftOk,
  });
} else {
  const langs = detectTesseractLanguages();
  const tesseractOk = commandExists("tesseract");
  addResult({
    detail: tesseractOk
      ? `found tesseract; languages chi_sim=${langs.hasChinese}, eng=${langs.hasEnglish}`
      : "tesseract not found",
    install: isWindows
      ? "Run scripts/install-system-deps.ps1, or install Tesseract OCR and Chinese/English language data manually."
      : "Install tesseract and language data for chi_sim+eng.",
    name: "OCR provider: tesseract",
    ok: tesseractOk && langs.hasChinese && langs.hasEnglish,
  });
}

const runtime = readModelRuntime();
if (runtime === "kimi-cli") {
  const kimiPath = process.env.KIMI_CLI_PATH;
  addResult({
    detail: kimiPath
      ? existsSync(kimiPath)
        ? `found: ${kimiPath}`
        : `KIMI_CLI_PATH is set but does not exist: ${kimiPath}`
      : commandExists("kimi")
        ? "found kimi in PATH"
        : "kimi command not found",
    install:
      "Install the official Kimi CLI for your platform, or set KIMI_CLI_PATH to the executable.",
    name: "Kimi CLI runtime",
    ok: kimiPath ? existsSync(kimiPath) : commandExists("kimi"),
  });
} else {
  addResult({
    detail: `runtime=${runtime}`,
    name: "Agent runtime",
    ok: true,
    required: false,
  });
}

console.log("\nSVG to HTML system dependency check");
console.log(`Platform: ${process.platform} ${os.release()}`);
console.log(`Mode: ${isPostinstall ? "postinstall warning-only" : "doctor"}\n`);

for (const item of result) {
  const mark = item.ok ? "OK" : item.required ? "MISSING" : "INFO";
  console.log(
    `[${mark}] ${item.name}${item.detail ? ` - ${item.detail}` : ""}`,
  );
  if (!item.ok && item.install) console.log(`      ${item.install}`);
}

const failed = result.filter((item) => item.required && !item.ok);
if (failed.length) {
  console.log("\nSome system dependencies are missing.");
  console.log(
    "pnpm install only installs Node.js dependencies from package.json.",
  );
  console.log("Run pnpm doctor after installing the missing tools.");
  process.exitCode = isPostinstall ? 0 : 1;
} else {
  console.log("\nAll required system dependencies look available.");
}
