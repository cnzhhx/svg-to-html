/**
 * Browser Tools MCP Server
 *
 * 通过 stdio 暴露一个 MCP server，提供 `browser_eval` 和
 * `export_svg_node` tool。
 * 内部持有常驻 BrowserSession，每个模块一个 tab，按需打开，
 * evaluate 前自动 reload 以反映最新 preview.fragment.html / module.css。
 *
 * 由 opencode 通过 [node, dist/browser-mcp-server.mjs, --scale, <scale>] 启动。
 */

import process from "node:process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { exportSvgNodeAsset } from "../cli/export-svg-node-asset.js";
import { BrowserSession } from "../core/browser-session.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

const BROWSER_EVAL_TOOL = {
  description:
    "在模块的 HTML 预览页面中执行 JavaScript，返回 JSON 结果。页面会自动加载最新的 preview.fragment.html 和 module.css。用于查询真实 DOM 的 getBoundingClientRect、getComputedStyle 等信息。",
  inputSchema: {
    properties: {
      moduleDir: {
        description: "模块目录的绝对路径",
        type: "string",
      },
      script: {
        description:
          "要在页面上下文中执行的 JavaScript 代码，最后需要 return 一个 JSON-serializable 的值",
        type: "string",
      },
    },
    required: ["moduleDir", "script"],
    type: "object",
  },
  name: "browser_eval",
} as const;

const EXPORT_SVG_NODE_TOOL = {
  description:
    "将模块 SVG 中的一个或多个可见节点导出为 PNG，并写入 module-semantic.json 的 generatedAssets。用于复杂非文本视觉、图标、装饰层、图片内容等资产导出；会阻止导出预处理 DOM textBlocks。",
  inputSchema: {
    properties: {
      assetRole: {
        description: "可选资产角色，例如 visual-asset、photo-or-bitmap、icon-or-illustration",
        type: "string",
      },
      moduleDir: {
        description: "模块目录的绝对路径",
        type: "string",
      },
      nodeIds: {
        description:
          "module-semantic.json 中的 SVG 节点 id。传多个 id 会合并导出成一张 PNG",
        items: { type: "string" },
        type: "array",
      },
      output: {
        description: "模块目录内的输出路径，例如 assets/icon-a.png",
        type: "string",
      },
      padding: {
        default: 0,
        description: "导出裁切框四周额外 padding，单位 px",
        type: "number",
      },
      textTreatment: {
        description: "可选文本处理说明；通常不需要传",
        type: "string",
      },
    },
    required: ["moduleDir", "nodeIds", "output"],
    type: "object",
  },
  name: "export_svg_node",
} as const;

const parseScaleArg = (args: string[]): number => {
  const index = args.indexOf("--scale");
  if (index !== -1 && args[index + 1]) {
    const parsed = Number(args[index + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
};

const makeJsonRpcResponse = (id: unknown, result: unknown) =>
  JSON.stringify({ id, jsonrpc: "2.0", result });

const makeJsonRpcError = (
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
) =>
  JSON.stringify({
    error: data !== undefined ? { code, data, message } : { code, message },
    id,
    jsonrpc: "2.0",
  });

const makeMcpMessage = (payload: string) => `${payload}\n`;

const logDebug = (message: string) => {
  if (process.env["BROWSER_MCP_DEBUG"]) {
    process.stderr.write(`[browser-mcp-server] ${message}\n`);
  }
};

class McpServer {
  private session: BrowserSession | null = null;
  private sessionPromise: Promise<BrowserSession> | null = null;
  private closed = false;
  private moduleFileMtimes = new Map<string, number>();
  private moduleIds = new Map<string, string>();

  constructor(private readonly deviceScaleFactor: number) {}

  async start() {
    process.stdin.on("data", (chunk) => this.onStdinData(chunk));
    process.stdin.on("end", () => this.shutdown());

    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    process.on("exit", () => this.shutdownSync());

    await new Promise<void>((resolve) => {
      process.stdin.on("close", resolve);
    });
  }

  private onStdinData(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.lineBuffer += text;
    this.processLines();
  }

  private lineBuffer = "";

  private processLines() {
    while (!this.closed) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (!line) continue;
      // Skip Content-Length headers (some clients may send them)
      if (/^Content-Length:/i.test(line)) continue;

      void this.handleMessage(line);
    }
  }

  private async handleMessage(raw: string) {
    let message: {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.write(makeJsonRpcError(null, -32700, `Parse error: ${detail}`));
      return;
    }

    const { id, method, params } = message;

    if (method === "initialize") {
      this.write(
        makeJsonRpcResponse(id, {
          capabilities: { tools: {} },
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "browser-eval-mcp-server", version: "0.1.0" },
        }),
      );
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      this.write(
        makeJsonRpcResponse(id, {
          tools: [BROWSER_EVAL_TOOL, EXPORT_SVG_NODE_TOOL],
        }),
      );
      return;
    }

    if (method === "tools/call") {
      await this.handleToolCall(id, params ?? {});
      return;
    }

    this.write(
      makeJsonRpcError(id ?? null, -32601, `Method not found: ${String(method)}`),
    );
  }

  private async handleToolCall(
    id: unknown,
    params: Record<string, unknown>,
  ) {
    const toolName =
      typeof params.name === "string" ? params.name : "browser_eval";
    if (toolName === "browser_eval") {
      await this.handleBrowserEvalToolCall(id, params);
      return;
    }
    if (toolName === "export_svg_node") {
      await this.handleExportSvgNodeToolCall(id, params);
      return;
    }
    this.write(makeJsonRpcError(id, -32601, `Unknown tool: ${toolName}`));
  }

  private async handleBrowserEvalToolCall(
    id: unknown,
    params: Record<string, unknown>,
  ) {
    try {
      const args = params.arguments as Record<string, unknown> | undefined;
      const moduleDir =
        typeof args?.moduleDir === "string"
          ? args.moduleDir
          : typeof params.moduleDir === "string"
            ? params.moduleDir
            : undefined;
      const script =
        typeof args?.script === "string"
          ? args.script
          : typeof params.script === "string"
            ? params.script
            : undefined;

      if (!moduleDir || !script) {
        this.write(
          makeJsonRpcError(
            id,
            -32602,
            "Missing required arguments: moduleDir and script",
          ),
        );
        return;
      }

      const session = await this.getSession();
      let moduleId = this.moduleIds.get(moduleDir);
      if (!moduleId || !session.hasModule(moduleId)) {
        moduleId = await session.openModule(moduleDir);
        this.moduleIds.set(moduleDir, moduleId);
      }
      const skipReload = !(await this.shouldReloadModule(moduleDir));
      const result = await session.evaluate(moduleId, script, { skipReload });

      this.write(
        makeJsonRpcResponse(id, {
          content: [
            { text: JSON.stringify(result, null, 2), type: "text" },
          ],
          isError: false,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(`tool call failed: ${message}`);
      this.write(
        makeJsonRpcError(id, -32603, `Tool execution failed: ${message}`),
      );
    }
  }

  private async handleExportSvgNodeToolCall(
    id: unknown,
    params: Record<string, unknown>,
  ) {
    try {
      const args = params.arguments as Record<string, unknown> | undefined;
      const moduleDir =
        typeof args?.moduleDir === "string"
          ? args.moduleDir
          : typeof params.moduleDir === "string"
            ? params.moduleDir
            : undefined;
      const nodeIdsRaw = Array.isArray(args?.nodeIds)
        ? args.nodeIds
        : Array.isArray(params.nodeIds)
          ? params.nodeIds
          : undefined;
      const output =
        typeof args?.output === "string"
          ? args.output
          : typeof params.output === "string"
            ? params.output
            : undefined;
      const paddingRaw =
        typeof args?.padding === "number" || typeof args?.padding === "string"
          ? args.padding
          : typeof params.padding === "number" || typeof params.padding === "string"
            ? params.padding
            : undefined;
      const assetRole =
        typeof args?.assetRole === "string"
          ? args.assetRole
          : typeof params.assetRole === "string"
            ? params.assetRole
            : undefined;
      const textTreatment =
        typeof args?.textTreatment === "string"
          ? args.textTreatment
          : typeof params.textTreatment === "string"
            ? params.textTreatment
            : undefined;

      const nodeIds = (nodeIdsRaw ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const padding = paddingRaw === undefined ? 0 : Number(paddingRaw);

      if (!moduleDir || nodeIds.length === 0 || !output) {
        this.write(
          makeJsonRpcError(
            id,
            -32602,
            "Missing required arguments: moduleDir, nodeIds, and output",
          ),
        );
        return;
      }
      if (!Number.isFinite(padding) || padding < 0) {
        this.write(
          makeJsonRpcError(
            id,
            -32602,
            "Invalid padding: expected a non-negative number",
          ),
        );
        return;
      }

      const result = await exportSvgNodeAsset({
        allowText: false,
        assetRole,
        elementIndex: undefined,
        help: false,
        moduleDir,
        moduleSvg: "module.svg",
        nodeIds,
        output,
        padding,
        registerSemantic: true,
        scale: this.deviceScaleFactor,
        selector: undefined,
        textTreatment,
      });

      this.write(
        makeJsonRpcResponse(id, {
          content: [
            { text: JSON.stringify(result, null, 2), type: "text" },
          ],
          isError: false,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug(`export_svg_node failed: ${message}`);
      this.write(
        makeJsonRpcError(id, -32603, `Tool execution failed: ${message}`),
      );
    }
  }

  private async getSession(): Promise<BrowserSession> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = BrowserSession.create({
      deviceScaleFactor: this.deviceScaleFactor,
    }).then((session) => {
      this.session = session;
      this.sessionPromise = null;
      return session;
    });

    return this.sessionPromise;
  }

  private async getModuleFileMtime(moduleDir: string): Promise<number> {
    try {
      const [previewStat, cssStat] = await Promise.all([
        stat(path.join(moduleDir, "preview.fragment.html")),
        stat(path.join(moduleDir, "module.css")),
      ]);
      return Math.max(previewStat.mtimeMs, cssStat.mtimeMs);
    } catch {
      return 0;
    }
  }

  private async shouldReloadModule(moduleDir: string): Promise<boolean> {
    const current = await this.getModuleFileMtime(moduleDir);
    const previous = this.moduleFileMtimes.get(moduleDir) ?? 0;
    this.moduleFileMtimes.set(moduleDir, current);
    return current !== previous;
  }

  private write(message: string) {
    if (this.closed) return;
    process.stdout.write(makeMcpMessage(message));
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    if (session) {
      this.session = null;
      session.destroy().catch(() => {});
    }
    process.exit(0);
  }

  private shutdownSync() {
    this.closed = true;
  }
}

const main = async () => {
  const scale = parseScaleArg(process.argv.slice(2));
  logDebug(`starting with scale=${scale}`);
  const server = new McpServer(scale);
  await server.start();
};

main().catch((error) => {
  process.stderr.write(
    `browser-mcp-server fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
