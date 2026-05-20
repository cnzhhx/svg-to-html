import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import type { AgentReasoningEffort } from "../../config/agent-reasoning.js";
import type { ModelProviderConfig } from "../../config/model-provider.js";
import type {
  AgentInput,
  AgentRuntime,
  AgentThread,
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurn,
  ThreadOptions,
  Usage,
} from "./types.js";

type KimiToolCall = {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
  type?: string;
};

type PendingTool = {
  command?: string;
  filePath?: string;
  id: string;
  name: string;
};

type WireTool = {
  argumentsText: string;
  id: string;
  name: string;
};

const textDecoder = new TextDecoder();

const normalizeInput = async (input: AgentInput) => {
  if (typeof input === "string") {
    return JSON.stringify({
      content: [{ text: input, type: "text" }],
      role: "user",
    });
  }

  const content: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item.type === "text") {
      content.push({ text: item.text, type: "text" });
    } else {
      content.push({
        image_url: {
          url: await createDataUrl(item.path),
        },
        type: "image_url",
      });
    }
  }
  return JSON.stringify({ content, role: "user" });
};

const inputHasImages = (input: AgentInput) =>
  Array.isArray(input) && input.some((item) => item.type === "local_image");

const createWireUserInput = async (input: AgentInput) => {
  if (typeof input === "string") return input;
  const content: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item.type === "text") {
      content.push({ text: item.text, type: "text" });
    } else {
      content.push({
        image_url: { url: await createDataUrl(item.path) },
        type: "image_url",
      });
    }
  }
  return content;
};

const createDataUrl = async (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType =
    extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return `data:${mimeType};base64,${Buffer.concat(chunks).toString("base64")}`;
};

const shouldEnableThinking = (effort: AgentReasoningEffort | undefined) =>
  effort === "high" || effort === "xhigh";

const createKimiConfigFile = async (
  modelConfig: ModelProviderConfig,
  reasoningEffort: AgentReasoningEffort | undefined,
) => {
  const dir = await mkdtemp(path.join(tmpdir(), "svg-kimi-config-"));
  const configPath = path.join(dir, "config.json");
  const modelId = modelConfig.cliModel ?? modelConfig.model;
  const providerConfig: Record<string, unknown> = {
    api_key: modelConfig.apiKey,
    base_url: modelConfig.baseURL,
    type: "kimi",
  };
  if (Object.keys(modelConfig.headers).length > 0) {
    providerConfig.custom_headers = modelConfig.headers;
  }
  await writeFile(
    configPath,
    JSON.stringify(
      {
        default_model: modelId,
        default_thinking: shouldEnableThinking(reasoningEffort),
        models: {
          [modelId]: {
            capabilities: ["thinking", "image_in"],
            max_context_size: 262144,
            model: modelConfig.model,
            provider: modelConfig.provider,
          },
        },
        providers: {
          [modelConfig.provider]: providerConfig,
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    cleanup: () => rm(dir, { force: true, recursive: true }),
    configPath,
  };
};

const extractText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const extractThinking = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "think" && typeof record.think === "string") {
        return record.think;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const parseToolArguments = (toolCall: KimiToolCall) => {
  const raw = toolCall.function?.arguments;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const toolResultToText = (content: unknown) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const inferExitCode = (output: string) => {
  const explicitExitCode = output.match(
    /Command failed with exit code:\s*(\d+)/i,
  );
  if (explicitExitCode?.[1]) return Number(explicitExitCode[1]);
  if (/<system>ERROR:/i.test(output)) return 1;
  if (
    /Command killed by timeout|Failed to (?:write|edit|read|start)/i.test(
      output,
    )
  ) {
    return 1;
  }
  return 0;
};

const classifyFileTool = (name: string) =>
  /write|create/i.test(name)
    ? "update"
    : /delete|remove/i.test(name)
      ? "delete"
      : "update";

const createMessageItem = (text: string): AgentThreadItem => ({
  id: `kimi-message-${randomUUID()}`,
  text,
  type: "agent_message",
});

const normalizeTodoItems = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const text =
        typeof record.title === "string"
          ? record.title
          : typeof record.text === "string"
            ? record.text
            : undefined;
      if (!text) return undefined;
      return {
        completed: record.status === "done" || record.completed === true,
        text,
      };
    })
    .filter((item): item is { completed: boolean; text: string } =>
      Boolean(item),
    );
  return items.length ? items : undefined;
};

const toRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const getWirePayload = (parsed: Record<string, unknown>) => {
  const params = toRecord(parsed.params);
  if (!params) return {};
  return {
    payload: toRecord(params.payload),
    type: typeof params.type === "string" ? params.type : undefined,
  };
};

const appendWireUsage = (current: Usage, payload: Record<string, unknown>) => {
  const tokenUsage = toRecord(payload.token_usage);
  if (!tokenUsage) return current;
  const inputOther =
    typeof tokenUsage.input_other === "number" ? tokenUsage.input_other : 0;
  const inputCacheRead =
    typeof tokenUsage.input_cache_read === "number"
      ? tokenUsage.input_cache_read
      : 0;
  const inputCacheCreation =
    typeof tokenUsage.input_cache_creation === "number"
      ? tokenUsage.input_cache_creation
      : 0;
  const output = typeof tokenUsage.output === "number" ? tokenUsage.output : 0;
  return {
    cached_input_tokens: (current.cached_input_tokens ?? 0) + inputCacheRead,
    input_tokens:
      current.input_tokens + inputOther + inputCacheRead + inputCacheCreation,
    output_tokens: current.output_tokens + output,
  };
};

const writeJsonLine = (
  stdin: NodeJS.WritableStream & { destroyed?: boolean; writable?: boolean },
  value: Record<string, unknown>,
) => {
  if (stdin.destroyed || stdin.writable === false) return;
  stdin.write(`${JSON.stringify(value)}\n`);
};

class KimiCliThread implements AgentThread {
  private _id: string | null = null;

  constructor(
    private readonly modelConfig: ModelProviderConfig,
    private readonly options: ThreadOptions,
  ) {}

  get id() {
    return this._id;
  }

  async runStreamed(
    input: AgentInput,
    turnOptions: { signal?: AbortSignal } = {},
  ) {
    return {
      events: this.runStreamedInternal(input, turnOptions),
    };
  }

  async run(
    input: AgentInput,
    turnOptions: { signal?: AbortSignal } = {},
  ): Promise<AgentTurn> {
    const streamed = await this.runStreamed(input, turnOptions);
    const items: AgentThreadItem[] = [];
    let finalResponse = "";
    let usage: Usage | null = null;
    let turnFailure: string | null = null;
    for await (const event of streamed.events) {
      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error.message;
        break;
      }
    }
    if (turnFailure) throw new Error(turnFailure);
    return { finalResponse, items, usage };
  }

  private async *runStreamedInternal(
    input: AgentInput,
    turnOptions: { signal?: AbortSignal },
  ): AsyncGenerator<AgentThreadEvent> {
    const threadId = this._id ?? randomUUID();
    this._id = threadId;
    yield { thread_id: threadId, type: "thread.started" };
    yield { type: "turn.started" };

    if (inputHasImages(input)) {
      yield* this.runWireStreamedInternal(threadId, input, turnOptions);
      return;
    }

    if (turnOptions.signal?.aborted) {
      yield {
        error: {
          message: `aborted: ${String(turnOptions.signal.reason ?? "aborted")}`,
        },
        type: "turn.failed",
      };
      return;
    }

    const reasoningEffort =
      this.options.modelReasoningEffort ?? this.modelConfig.reasoningEffort;
    const { cleanup, configPath } = await createKimiConfigFile(
      this.modelConfig,
      reasoningEffort,
    );
    const normalizedInput = await normalizeInput(input);
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--config-file",
      configPath,
      "--model",
      this.modelConfig.cliModel ?? this.modelConfig.model,
      "--session",
      threadId,
      "--work-dir",
      this.options.workingDirectory ?? process.cwd(),
      "--max-steps-per-turn",
      String(process.env["KIMI_MAX_STEPS_PER_TURN"] ?? 100),
    ];
    for (const directory of this.options.additionalDirectories ?? []) {
      args.push("--add-dir", directory);
    }

    const child = spawn(process.env["KIMI_CLI_PATH"] ?? "kimi", args, {
      cwd: this.options.workingDirectory ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{
      code: number | null;
      error?: Error;
      signal: string | null;
    }>((resolve) => {
      const childEvents = child as unknown as {
        once(event: "error", listener: (error: Error) => void): void;
        once(
          event: "exit",
          listener: (code: number | null, signal: string | null) => void,
        ): void;
      };
      let settled = false;
      const settle = (exit: {
        code: number | null;
        error?: Error;
        signal: string | null;
      }) => {
        if (settled) return;
        settled = true;
        resolve(exit);
      };
      childEvents.once("error", (error) =>
        settle({ code: 1, error, signal: null }),
      );
      childEvents.once("exit", (code, signal) => settle({ code, signal }));
    });
    const pendingTools = new Map<string, PendingTool>();
    const finalMessages: string[] = [];
    let stderr = "";
    let turnFailed: string | null = null;
    let abortRequested = false;

    const abort = () => {
      abortRequested = true;
      child.kill("SIGTERM");
    };
    if (turnOptions.signal?.aborted) abort();
    turnOptions.signal?.addEventListener("abort", abort, { once: true });

    child.stdin.on("error", (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    });
    child.stdin.end(`${normalizedInput}\n`);
    child.stderr?.on("data", (chunk) => {
      stderr += textDecoder.decode(chunk);
    });

    const rl = readline.createInterface({
      crlfDelay: Infinity,
      input: child.stdout,
    });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith("{")) {
          const resumeMatch = trimmed.match(/kimi -r ([0-9a-f-]+)/i);
          if (resumeMatch?.[1]) this._id = resumeMatch[1];
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          yield { message: trimmed, type: "error" };
          continue;
        }

        const role = parsed.role;
        if (role === "assistant") {
          const thinking = extractThinking(parsed.content);
          if (thinking) {
            yield {
              item: {
                id: `kimi-reasoning-${randomUUID()}`,
                text: thinking,
                type: "reasoning",
              },
              type: "item.completed",
            };
          }

          const toolCalls = Array.isArray(parsed.tool_calls)
            ? (parsed.tool_calls as KimiToolCall[])
            : [];
          for (const toolCall of toolCalls) {
            const id = toolCall.id ?? `kimi-tool-${randomUUID()}`;
            const name = toolCall.function?.name ?? "tool";
            const argsObject = parseToolArguments(toolCall);
            const command =
              typeof argsObject.command === "string"
                ? argsObject.command
                : undefined;
            const filePath =
              typeof argsObject.path === "string" ? argsObject.path : undefined;
            const todoItems =
              name === "SetTodoList"
                ? normalizeTodoItems(argsObject.todos)
                : undefined;
            pendingTools.set(id, { command, filePath, id, name });
            if (todoItems) {
              yield {
                item: {
                  id,
                  items: todoItems,
                  type: "todo_list",
                },
                type: "item.completed",
              };
            }
            if (command) {
              yield {
                item: {
                  aggregated_output: "",
                  command,
                  id,
                  status: "in_progress",
                  type: "command_execution",
                },
                type: "item.started",
              };
            }
          }

          const text = extractText(parsed.content);
          if (text) {
            finalMessages.push(text);
            yield { item: createMessageItem(text), type: "item.completed" };
          }
        } else if (role === "tool") {
          const toolCallId =
            typeof parsed.tool_call_id === "string"
              ? parsed.tool_call_id
              : undefined;
          if (!toolCallId) continue;
          const pendingTool = pendingTools.get(toolCallId);
          if (!pendingTool) continue;
          const output = toolResultToText(parsed.content);
          if (pendingTool.command) {
            const exitCode = inferExitCode(output);
            yield {
              item: {
                aggregated_output: output,
                command: pendingTool.command,
                exit_code: exitCode,
                id: toolCallId,
                status: exitCode === 0 ? "completed" : "failed",
                type: "command_execution",
              },
              type: "item.completed",
            };
          } else if (pendingTool.filePath) {
            const resolvedPath = path.isAbsolute(pendingTool.filePath)
              ? pendingTool.filePath
              : path.join(
                  this.options.workingDirectory ?? process.cwd(),
                  pendingTool.filePath,
                );
            const exists = await stat(resolvedPath)
              .then(() => true)
              .catch(() => false);
            yield {
              item: {
                changes: [
                  {
                    kind: exists
                      ? classifyFileTool(pendingTool.name)
                      : "update",
                    path: pendingTool.filePath,
                  },
                ],
                id: toolCallId,
                status: inferExitCode(output) === 0 ? "completed" : "failed",
                type: "file_change",
              },
              type: "item.completed",
            };
          }
          pendingTools.delete(toolCallId);
        }
      }

      const exit = await exitPromise;
      if (abortRequested || turnOptions.signal?.aborted) {
        turnFailed = `aborted: ${String(turnOptions.signal?.reason ?? "aborted")}`;
      } else if (exit.error) {
        turnFailed = `Failed to start Kimi CLI: ${exit.error.message}`;
      } else if (exit.code !== 0 || exit.signal) {
        turnFailed =
          stderr.trim() ||
          `Kimi CLI exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`}`;
      }
    } finally {
      turnOptions.signal?.removeEventListener("abort", abort);
      rl.close();
      await cleanup();
    }

    if (turnFailed) {
      yield { error: { message: turnFailed }, type: "turn.failed" };
      return;
    }

    if (!finalMessages.length) {
      yield {
        item: createMessageItem(""),
        type: "item.completed",
      };
    }
    yield {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }

  private async *runWireStreamedInternal(
    threadId: string,
    input: AgentInput,
    turnOptions: { signal?: AbortSignal },
  ): AsyncGenerator<AgentThreadEvent> {
    if (turnOptions.signal?.aborted) {
      yield {
        error: {
          message: `aborted: ${String(turnOptions.signal.reason ?? "aborted")}`,
        },
        type: "turn.failed",
      };
      return;
    }

    const reasoningEffort =
      this.options.modelReasoningEffort ?? this.modelConfig.reasoningEffort;
    const { cleanup, configPath } = await createKimiConfigFile(
      this.modelConfig,
      reasoningEffort,
    );
    const userInput = await createWireUserInput(input);
    const args = [
      "--wire",
      "--yolo",
      "--config-file",
      configPath,
      "--model",
      this.modelConfig.cliModel ?? this.modelConfig.model,
      "--session",
      threadId,
      "--work-dir",
      this.options.workingDirectory ?? process.cwd(),
      "--max-steps-per-turn",
      String(process.env["KIMI_MAX_STEPS_PER_TURN"] ?? 100),
    ];
    for (const directory of this.options.additionalDirectories ?? []) {
      args.push("--add-dir", directory);
    }

    const child = spawn(process.env["KIMI_CLI_PATH"] ?? "kimi", args, {
      cwd: this.options.workingDirectory ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = new Promise<{
      code: number | null;
      error?: Error;
      signal: string | null;
    }>((resolve) => {
      const childEvents = child as unknown as {
        once(event: "error", listener: (error: Error) => void): void;
        once(
          event: "exit",
          listener: (code: number | null, signal: string | null) => void,
        ): void;
      };
      let settled = false;
      const settle = (exit: {
        code: number | null;
        error?: Error;
        signal: string | null;
      }) => {
        if (settled) return;
        settled = true;
        resolve(exit);
      };
      childEvents.once("error", (error) =>
        settle({ code: 1, error, signal: null }),
      );
      childEvents.once("exit", (code, signal) => settle({ code, signal }));
    });

    const promptId = `kimi-wire-prompt-${randomUUID()}`;
    const cancelId = `kimi-wire-cancel-${randomUUID()}`;
    const pendingTools = new Map<string, WireTool>();
    const textChunks: string[] = [];
    const thinkingChunks: string[] = [];
    let activeToolId: string | null = null;
    let abortRequested = false;
    let promptCompleted = false;
    let promptFailed: string | null = null;
    let stderr = "";
    let turnFailed: string | null = null;
    let usage: Usage = {
      cached_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    };

    const stopChild = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const abort = () => {
      abortRequested = true;
      writeJsonLine(child.stdin, {
        id: cancelId,
        jsonrpc: "2.0",
        method: "cancel",
      });
      stopChild();
    };
    if (turnOptions.signal?.aborted) abort();
    turnOptions.signal?.addEventListener("abort", abort, { once: true });

    child.stdin.on("error", (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += textDecoder.decode(chunk);
    });

    const rl = readline.createInterface({
      crlfDelay: Infinity,
      input: child.stdout,
    });

    writeJsonLine(child.stdin, {
      id: promptId,
      jsonrpc: "2.0",
      method: "prompt",
      params: {
        user_input: userInput,
      },
    });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          yield { message: trimmed, type: "error" };
          continue;
        }

        if (parsed.method === "event") {
          const { payload, type } = getWirePayload(parsed);
          if (!type || !payload) continue;

          if (type === "ContentPart") {
            if (payload.type === "text" && typeof payload.text === "string") {
              textChunks.push(payload.text);
            } else if (
              payload.type === "think" &&
              typeof payload.think === "string"
            ) {
              thinkingChunks.push(payload.think);
            }
          } else if (type === "StatusUpdate") {
            usage = appendWireUsage(usage, payload);
          } else if (type === "ToolCall") {
            const toolCall = payload as KimiToolCall;
            const id = toolCall.id ?? `kimi-tool-${randomUUID()}`;
            pendingTools.set(id, {
              argumentsText: toolCall.function?.arguments ?? "",
              id,
              name: toolCall.function?.name ?? "tool",
            });
            activeToolId = id;
          } else if (type === "ToolCallPart") {
            const part =
              typeof payload.arguments_part === "string"
                ? payload.arguments_part
                : "";
            const activeTool = activeToolId
              ? pendingTools.get(activeToolId)
              : undefined;
            if (activeTool && part) {
              activeTool.argumentsText += part;
            }
          } else if (type === "ToolResult") {
            const toolCallId =
              typeof payload.tool_call_id === "string"
                ? payload.tool_call_id
                : undefined;
            const pendingTool = toolCallId
              ? pendingTools.get(toolCallId)
              : undefined;
            const returnValue = toRecord(payload.return_value);
            if (pendingTool && returnValue) {
              const argsObject = parseToolArguments({
                function: {
                  arguments: pendingTool.argumentsText,
                  name: pendingTool.name,
                },
                id: pendingTool.id,
              });
              const command =
                typeof argsObject.command === "string"
                  ? argsObject.command
                  : undefined;
              const output =
                typeof returnValue.output === "string"
                  ? returnValue.output
                  : "";
              const isError = returnValue.is_error === true;
              if (command) {
                yield {
                  item: {
                    aggregated_output: output,
                    command,
                    exit_code: isError ? 1 : inferExitCode(output),
                    id: pendingTool.id,
                    status: isError ? "failed" : "completed",
                    type: "command_execution",
                  },
                  type: "item.completed",
                };
              }
            }
            if (toolCallId) pendingTools.delete(toolCallId);
            if (toolCallId === activeToolId) activeToolId = null;
          }
          continue;
        }

        if (parsed.method === "request") {
          const { payload, type } = getWirePayload(parsed);
          const id = typeof parsed.id === "string" ? parsed.id : undefined;
          if (!id || !type || !payload) continue;
          if (type === "ApprovalRequest") {
            writeJsonLine(child.stdin, {
              id,
              jsonrpc: "2.0",
              result: {
                request_id: payload.id,
                response: "approve",
              },
            });
          } else if (type === "HookRequest") {
            writeJsonLine(child.stdin, {
              id,
              jsonrpc: "2.0",
              result: {
                action: "allow",
                reason: "",
                request_id: payload.id,
              },
            });
          } else if (type === "QuestionRequest") {
            writeJsonLine(child.stdin, {
              id,
              jsonrpc: "2.0",
              result: {
                answers: {},
                request_id: payload.id,
              },
            });
          } else {
            writeJsonLine(child.stdin, {
              error: {
                code: -32601,
                message: `Unsupported Kimi Wire request: ${type}`,
              },
              id,
              jsonrpc: "2.0",
            });
          }
          continue;
        }

        if (parsed.id === promptId) {
          const error = toRecord(parsed.error);
          if (error) {
            promptFailed =
              typeof error.message === "string"
                ? error.message
                : "Kimi Wire prompt failed";
          } else {
            const result = toRecord(parsed.result);
            const status =
              typeof result?.status === "string" ? result.status : "finished";
            if (status === "finished") {
              promptCompleted = true;
            } else {
              promptFailed = `Kimi Wire prompt ended with status "${status}"`;
            }
          }
          stopChild();
          break;
        }
      }

      const exit = await exitPromise;
      if (abortRequested || turnOptions.signal?.aborted) {
        turnFailed = `aborted: ${String(turnOptions.signal?.reason ?? "aborted")}`;
      } else if (promptFailed) {
        turnFailed = promptFailed;
      } else if (exit.error) {
        turnFailed = `Failed to start Kimi Wire: ${exit.error.message}`;
      } else if (!promptCompleted) {
        turnFailed =
          stderr.trim() ||
          `Kimi Wire exited before completing the prompt (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`})`;
      } else if (exit.code !== 0 && exit.signal !== "SIGTERM") {
        turnFailed =
          stderr.trim() ||
          `Kimi Wire exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`}`;
      }
    } finally {
      turnOptions.signal?.removeEventListener("abort", abort);
      rl.close();
      stopChild();
      await cleanup();
    }

    if (turnFailed) {
      yield { error: { message: turnFailed }, type: "turn.failed" };
      return;
    }

    const finalMessage = textChunks.join("");
    if (thinkingChunks.length) {
      yield {
        item: {
          id: `kimi-reasoning-${randomUUID()}`,
          text: thinkingChunks.join(""),
          type: "reasoning",
        },
        type: "item.completed",
      };
    }
    if (!finalMessage.trim()) {
      yield {
        error: {
          message: "Kimi Wire completed without assistant response text",
        },
        type: "turn.failed",
      };
      return;
    }
    yield { item: createMessageItem(finalMessage), type: "item.completed" };
    yield { type: "turn.completed", usage };
  }
}

const createKimiCliRuntime = (
  modelConfig: ModelProviderConfig,
): AgentRuntime => ({
  startThread(options?: ThreadOptions) {
    return new KimiCliThread(modelConfig, options ?? {});
  },
});

export { createKimiCliRuntime };
