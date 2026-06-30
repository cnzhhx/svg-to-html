/**
 * browser-query — 轻量 CLI，创建临时 BrowserSession 做 DOM 查询。
 *
 * 用法：
 *   pnpm exec tsx src/cli/browser-query.ts <module-dir>
 *     → 读取 <module-dir>/browser-eval.js 执行
 *
 *   pnpm exec tsx src/cli/browser-query.ts <module-dir> --script '<js>'
 *     → 直接执行内联 JS
 *
 * 注意：主流程已改用 MCP browser_eval tool。此 CLI 保留作为开发调试工具。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { BrowserSession } from "../core/browser-session.js";

const DEFAULT_SCRIPT_FILE_NAME = "browser-eval.js";

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--help") {
      return { help: true, moduleDir: ".", script: undefined, scriptFile: undefined };
    }

    if (arg === "--script" || arg === "--script-file") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, value);
      i += 1;
      continue;
    }

    if (arg.startsWith("--script=")) {
      values.set("--script", arg.slice("--script=".length));
      continue;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  return {
    help: false,
    moduleDir: positionals[0] ?? ".",
    script: values.get("--script"),
    scriptFile: values.get("--script-file"),
  };
};

const buildHelpText = () => `
browser-query — Lightweight DOM query against a module's rendered HTML.

Usage:
  pnpm exec tsx src/cli/browser-query.ts <module-dir>
  pnpm exec tsx src/cli/browser-query.ts <module-dir> --script '<js expression>'
  pnpm exec tsx src/cli/browser-query.ts <module-dir> --script-file <file>

Without --script/--script-file, reads <module-dir>/${DEFAULT_SCRIPT_FILE_NAME}.

Creates a temporary BrowserSession, loads the module's preview.fragment.html
and module.css with proper viewport dimensions (from module-semantic.json),
and evaluates the script in page context. The script must return
JSON-serializable data.
`.trim();

/**
 * 直连模式：创建临时 BrowserSession
 */
async function evaluateDirect(
  moduleDir: string,
  script: string,
): Promise<unknown> {
  const session = await BrowserSession.create();
  try {
    const moduleId = await session.openModule(moduleDir);
    return await session.evaluate(moduleId, script);
  } finally {
    await session.destroy();
  }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(buildHelpText());
    return;
  }

  const moduleDir = path.resolve(args.moduleDir);

  // 读取脚本内容
  let script: string;
  if (args.script) {
    script = args.script;
  } else if (args.scriptFile) {
    script = await readFile(path.resolve(args.scriptFile), "utf8");
  } else {
    const defaultPath = path.join(moduleDir, DEFAULT_SCRIPT_FILE_NAME);
    try {
      script = await readFile(defaultPath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Missing browser eval script. Write ${defaultPath} or pass --script. ${message}`,
      );
    }
  }

  const result = await evaluateDirect(moduleDir, script);
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
