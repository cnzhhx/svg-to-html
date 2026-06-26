/**
 * BrowserSession — 常驻无头浏览器会话，为模块 agent 提供低延迟 DOM 查询能力。
 *
 * 设计理念：
 * - 整个 session（多个模块并行）共享一个 Edge 进程（通过浏览器池）
 * - 每个模块独占一个 tab（CDP target），互不干扰
 * - 模块文件变更后自动 reload，agent 只需 evaluate JS 表达式
 * - 对外暴露简单的 open/evaluate/close 接口
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CdpClient,
  createTarget,
  closeTarget,
  launchEdge,
  waitForCondition,
} from "./cdp.js";

interface ModuleTabInfo {
  moduleId: string;
  moduleDir: string;
  targetId: string;
  cdp: CdpClient;
  htmlPath: string;
  tempDir: string;
  width: number;
  height: number;
}

interface BrowserSessionOptions {
  /** 设备缩放因子，默认 1 */
  deviceScaleFactor?: number;
}

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const readModuleMetadata = async (moduleDir: string) => {
  try {
    const raw = await readFile(
      path.join(moduleDir, "module-semantic.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      module?: { id?: unknown; region?: { width?: unknown; height?: unknown } };
    };
    const rawWidth = Number(parsed.module?.region?.width);
    const rawHeight = Number(parsed.module?.region?.height);
    const moduleId =
      typeof parsed.module?.id === "string"
        ? parsed.module.id
        : path.basename(moduleDir);
    if (
      Number.isFinite(rawWidth) &&
      rawWidth > 0 &&
      Number.isFinite(rawHeight) &&
      rawHeight > 0
    ) {
      return {
        height: Math.max(1, Math.ceil(rawHeight)),
        moduleId,
        width: Math.max(1, Math.ceil(rawWidth)),
      };
    }
  } catch {}
  return { height: 1024, moduleId: path.basename(moduleDir), width: 1024 };
};

const buildModulePreviewHtml = async ({
  moduleDir,
  moduleId,
  width,
  height,
}: {
  moduleDir: string;
  moduleId: string;
  width: number;
  height: number;
}) => {
  const [previewFragmentHtml, moduleCss] = await Promise.all([
    readFile(path.join(moduleDir, "preview.fragment.html"), "utf8"),
    readFile(path.join(moduleDir, "module.css"), "utf8"),
  ]);
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "svg-to-html-browser-session-"),
  );
  const filePath = path.join(tempDir, "preview.html");
  const moduleBaseUrl = pathToFileURL(`${moduleDir}${path.sep}`).href;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <base href="${escapeHtmlAttribute(moduleBaseUrl)}" />
    <meta name="viewport" content="width=${width}, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }
      .browser-eval-root {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }
      .design-module {
        position: absolute;
        left: 0;
        top: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }
      .design-module,
      .design-module * {
        box-sizing: border-box;
      }
${moduleCss.split("\n").map((line) => `      ${line}`).join("\n")}
    </style>
  </head>
  <body>
    <main class="browser-eval-root" data-module-dir="${escapeHtmlAttribute(moduleDir)}">
      <section class="design-module ${escapeHtmlAttribute(moduleId)}" data-module-id="${escapeHtmlAttribute(moduleId)}">
${previewFragmentHtml.trim()}
      </section>
    </main>
    <script>window.__RENDER_READY__ = true;</script>
  </body>
</html>
`;
  await writeFile(filePath, html, "utf8");
  return { filePath, tempDir };
};

const buildEvalExpression = (script: string) =>
  `(() => {
    const source = ${JSON.stringify(script)};
    const body =
      source.includes("\\n") || source.includes(";")
        ? source
        : \`return (\${source});\`;
    return (async () => {
      const normalize = (value) => (value === undefined ? null : value);
      return normalize(await new Function(
        \`return (async () => {\\n\${body}\\n})()\`,
      )());
    })();
  })()`;

const READY_EXPRESSION =
  'document.readyState === "complete" && window.__RENDER_READY__ === true';

export class BrowserSession {
  private port: number;
  private tabs = new Map<string, ModuleTabInfo>();
  private closeBrowser: () => Promise<void>;
  private deviceScaleFactor: number;
  private closed = false;

  private constructor(
    port: number,
    closeBrowser: () => Promise<void>,
    options?: BrowserSessionOptions,
  ) {
    this.port = port;
    this.closeBrowser = closeBrowser;
    this.deviceScaleFactor = options?.deviceScaleFactor ?? 1;
  }

  /** 创建一个新的 BrowserSession，复用全局浏览器池 */
  static async create(options?: BrowserSessionOptions): Promise<BrowserSession> {
    const browser = await launchEdge();
    return new BrowserSession(browser.port, browser.close, options);
  }

  /** 为一个模块打开常驻 tab，返回 moduleId */
  async openModule(moduleDir: string): Promise<string> {
    if (this.closed) throw new Error("BrowserSession is closed");
    const metadata = await readModuleMetadata(moduleDir);
    const { moduleId, width, height } = metadata;

    // 如果已经开了就先关闭旧 tab
    if (this.tabs.has(moduleId)) {
      await this.closeModule(moduleId);
    }

    const { filePath, tempDir } = await buildModulePreviewHtml({
      moduleDir,
      moduleId,
      width,
      height,
    });

    const target = await createTarget(this.port);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: this.deviceScaleFactor,
      height,
      mobile: false,
      screenHeight: height,
      screenWidth: width,
      width,
    });
    await cdp.send("Page.navigate", { url: pathToFileURL(filePath).href });
    await waitForCondition(cdp, READY_EXPRESSION, 10_000);

    this.tabs.set(moduleId, {
      moduleId,
      moduleDir,
      targetId: target.id,
      cdp,
      htmlPath: filePath,
      tempDir,
      width,
      height,
    });

    return moduleId;
  }

  /** 重新生成预览页面并 reload tab（文件变更后调用） */
  async reloadModule(moduleId: string): Promise<void> {
    if (this.closed) throw new Error("BrowserSession is closed");
    const tab = this.tabs.get(moduleId);
    if (!tab) throw new Error(`Module tab not found: ${moduleId}`);

    // 重新生成 HTML（包含最新的 fragment + css）
    const { filePath, tempDir: newTempDir } = await buildModulePreviewHtml({
      moduleDir: tab.moduleDir,
      moduleId: tab.moduleId,
      width: tab.width,
      height: tab.height,
    });

    const oldTempDir = tab.tempDir;

    // Navigate to new page
    await tab.cdp.send("Page.navigate", { url: pathToFileURL(filePath).href });
    await waitForCondition(tab.cdp, READY_EXPRESSION, 10_000);

    // 更新 tab 信息
    tab.htmlPath = filePath;
    tab.tempDir = newTempDir;

    // 异步清理旧临时文件
    rm(oldTempDir, { force: true, recursive: true }).catch(() => {});
  }

  /**
   * 在模块 tab 里执行 JS 表达式，自动 reload 以确保反映最新文件。
   * 返回 JSON-serializable 结果。
   */
  async evaluate<T = unknown>(
    moduleId: string,
    script: string,
    options?: { skipReload?: boolean },
  ): Promise<T> {
    if (this.closed) throw new Error("BrowserSession is closed");
    const tab = this.tabs.get(moduleId);
    if (!tab) throw new Error(`Module tab not found: ${moduleId}`);

    // 每次 evaluate 前 reload，确保是最新文件内容
    if (!options?.skipReload) {
      await this.reloadModule(moduleId);
    }

    const result = await tab.cdp.send<{
      exceptionDetails?: {
        exception?: { description?: string; value?: string };
        text?: string;
      };
      result?: { value?: T };
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: buildEvalExpression(script),
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text ??
        "Unknown page evaluation error";
      throw new Error(`Page evaluation failed: ${detail}`);
    }

    return result.result?.value as T;
  }

  /**
   * 执行 browser-eval.js 文件里的脚本（兼容旧模式）。
   * 先 reload 再读文件内容再 evaluate。
   */
  async evaluateFile(moduleId: string, scriptPath?: string): Promise<unknown> {
    const tab = this.tabs.get(moduleId);
    if (!tab) throw new Error(`Module tab not found: ${moduleId}`);
    const filePath = scriptPath ?? path.join(tab.moduleDir, "browser-eval.js");
    const script = await readFile(filePath, "utf8");
    return this.evaluate(moduleId, script);
  }

  /** 关闭某个模块的 tab */
  async closeModule(moduleId: string): Promise<void> {
    const tab = this.tabs.get(moduleId);
    if (!tab) return;
    this.tabs.delete(moduleId);
    try {
      tab.cdp.close();
      await closeTarget(this.port, tab.targetId);
    } catch {}
    rm(tab.tempDir, { force: true, recursive: true }).catch(() => {});
  }

  /** 检查某模块是否已有 tab */
  hasModule(moduleId: string): boolean {
    return this.tabs.has(moduleId);
  }

  /** 获取所有已打开的模块 ID */
  getOpenModuleIds(): string[] {
    return [...this.tabs.keys()];
  }

  /** 获取浏览器端口（用于 verify 等外部工具共享同一浏览器实例） */
  get browserPort(): number {
    return this.port;
  }

  /** 关闭所有 tab 并释放浏览器资源 */
  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tabIds = [...this.tabs.keys()];
    await Promise.allSettled(tabIds.map((id) => this.closeModule(id)));
    await this.closeBrowser();
  }
}
