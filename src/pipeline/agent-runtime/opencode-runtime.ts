import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { ModelProviderConfig } from "../../config/model-provider.js";
import { truncate } from "../../core/string-utils.js";
import type {
  AgentInput,
  AgentRuntime,
  AgentRunStreamedResult,
  AgentThread,
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurn,
  AgentTurnMetrics,
  ThreadOptions,
  Usage,
} from "./types.js";

type ProviderTelemetry = NonNullable<AgentTurnMetrics["providerTelemetry"]>;

type OpencodeModelRef = {
  modelName: string;
  modelRef: string;
  providerId: string;
};

type RuntimeTraceWriter = {
  tracePath: string;
  writeLine(line: string): Promise<void>;
};

type OpencodeEvent = {
  error?: unknown;
  part?: Record<string, unknown>;
  sessionID?: string;
  timestamp?: number;
  type?: string;
};

type OpencodeToolPart = {
  callID?: string;
  id?: string;
  state?: Record<string, unknown>;
  tool?: string;
};

type TurnMetricsRecorder = ReturnType<typeof createTurnMetricsRecorder>;

const DEFAULT_MESSAGE = "Continue.";
const MAX_REASONING_EVENT_CHARS = 8000;
const STDERR_SAMPLE_CHARS = 4000;
const TEXT_SAMPLE_CHARS = 200;
const THINK_SAMPLE_RECORD_LIMIT = 8;

const trimToUndefined = (value: string | undefined | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const compactSample = (value: string, maxChars: number) =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

const truncateReasoningForEvent = (text: string) =>
  truncate(
    text,
    MAX_REASONING_EVENT_CHARS,
    (value) => `\n[reasoning truncated for session event: ${value.length} chars total]`,
  );

const appendTailSample = (
  current: string,
  next: string,
  maxChars = STDERR_SAMPLE_CHARS,
) => {
  const merged = `${current}${next}`;
  return merged.length <= maxChars ? merged : merged.slice(-maxChars);
};

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const readRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readArray = (value: unknown) => (Array.isArray(value) ? value : []);

const mapFileChangeKind = (value: unknown): "add" | "delete" | "update" => {
  if (value === "add") return "add";
  if (value === "delete") return "delete";
  return "update";
};

const accumulateUsage = (
  current: Usage | null,
  next: Usage | null,
): Usage | null => {
  if (!current) return next;
  if (!next) return current;
  return {
    cached_input_tokens:
      (current.cached_input_tokens ?? 0) + (next.cached_input_tokens ?? 0),
    input_tokens: current.input_tokens + next.input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
  };
};

const createAgentMessageItem = (text: string): AgentThreadItem => ({
  id: `opencode-message-${randomUUID()}`,
  text,
  type: "agent_message",
});

const normalizeInput = (input: AgentInput) => {
  if (typeof input === "string") {
    return {
      files: [] as string[],
      message: trimToUndefined(input) ?? DEFAULT_MESSAGE,
    };
  }

  const files: string[] = [];
  const textParts: string[] = [];
  for (const item of input) {
    if (item.type === "text") {
      textParts.push(item.text);
      continue;
    }
    files.push(item.path);
  }

  return {
    files,
    message: trimToUndefined(textParts.join("\n\n")) ?? DEFAULT_MESSAGE,
  };
};

const resolveOpencodeModelRef = (
  modelConfig: ModelProviderConfig,
): OpencodeModelRef => {
  const rawModel = trimToUndefined(modelConfig.cliModel) ?? modelConfig.model;
  const slashIndex = rawModel.indexOf("/");
  if (slashIndex > 0) {
    return {
      modelName: rawModel.slice(slashIndex + 1),
      modelRef: rawModel,
      providerId: rawModel.slice(0, slashIndex),
    };
  }
  const provider = trimToUndefined(modelConfig.provider);
  if (!provider) {
    throw new Error(
      `Model config "${modelConfig.id}" uses runtime="opencode" but does not define provider or a provider-prefixed cliModel.`,
    );
  }
  return {
    modelName: rawModel,
    modelRef: `${provider}/${rawModel}`,
    providerId: provider,
  };
};

const normalizeReasoningEffort = (value: string | undefined | null) => {
  const variant = trimToUndefined(value);
  if (!variant) return undefined;
  return variant.toLowerCase();
};

const resolveOpencodeVariant = (
  value: string | undefined | null,
  modelConfig: ModelProviderConfig,
) => {
  const variant = normalizeReasoningEffort(value);
  if (!variant) return undefined;
  if (variant === "none") return undefined;
  if (variant === "xhigh" && modelConfig.wireApi !== "responses") {
    return "max";
  }
  return variant;
};

const getResponsesReasoningOptions = (
  effort: string | undefined | null,
): Record<string, unknown> | undefined => {
  const reasoningEffort = normalizeReasoningEffort(effort);
  if (!reasoningEffort) return undefined;
  if (reasoningEffort === "none") return undefined;
  return {
    reasoningEffort,
    reasoningSummary: "auto",
  };
};

const getResponsesReasoningVariants = () => ({
  high: {
    reasoningEffort: "high",
    reasoningSummary: "auto",
  },
  low: {
    reasoningEffort: "low",
    reasoningSummary: "auto",
  },
  medium: {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
  },
  minimal: {
    reasoningEffort: "minimal",
    reasoningSummary: "auto",
  },
  none: {
    reasoningEffort: "none",
    reasoningSummary: "auto",
  },
  xhigh: {
    reasoningEffort: "xhigh",
    reasoningSummary: "auto",
  },
});

const createRuntimeTraceWriter = async ({
  modelConfig,
  options,
}: {
  modelConfig: ModelProviderConfig;
  options: ThreadOptions;
}): Promise<RuntimeTraceWriter | undefined> => {
  if (!modelConfig.runtimeTrace) return undefined;
  const traceDir =
    options.runtimeTraceDir ??
    path.join(options.workingDirectory ?? process.cwd(), ".runtime-traces");
  await mkdir(traceDir, { recursive: true });
  const traceLabel = trimToUndefined(options.runtimeTraceLabel);
  const filename = `${traceLabel ? `${traceLabel}-` : ""}opencode-${Date.now()}-${randomUUID()}.jsonl`;
  const tracePath = path.join(traceDir, filename);
  return {
    tracePath,
    async writeLine(line: string) {
      await appendFile(tracePath, `${line}\n`, "utf8");
    },
  };
};

const createProviderTelemetry = ({
  modelConfig,
  modelRef,
}: {
  modelConfig: ModelProviderConfig;
  modelRef: OpencodeModelRef;
}): ProviderTelemetry => ({
  baseURL: modelConfig.baseURL,
  errorBodies: [],
  errorMessages: [],
  httpStatusCodes: [],
  model: modelRef.modelName,
  provider: modelRef.providerId,
  providerRequestIds: [],
  retryCount: 0,
  retryEvents: [],
});

const getProviderNpmPackage = (modelConfig: ModelProviderConfig) =>
  modelConfig.wireApi === "responses"
    ? "@ai-sdk/openai"
    : "@ai-sdk/openai-compatible";

const createOpencodeConfigFile = async ({
  modelConfig,
  modelRef,
  options,
}: {
  modelConfig: ModelProviderConfig;
  modelRef: OpencodeModelRef;
  options: ThreadOptions;
}) => {
  const dir = await mkdtemp(path.join(tmpdir(), "svg-opencode-config-"));
  const configPath = path.join(dir, "config.json");
  const allowEdits = options.sandboxMode !== "read-only";
  const allowNetwork = options.networkAccessEnabled !== false;
  const allowWebSearch = allowNetwork && options.webSearchEnabled !== false;
  const providerOptions: Record<string, unknown> = {
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL,
  };

  if (Object.keys(modelConfig.headers).length > 0) {
    providerOptions.headers = modelConfig.headers;
  }
  const responsesReasoningOptions =
    modelConfig.wireApi === "responses"
      ? getResponsesReasoningOptions(options.modelReasoningEffort)
      : undefined;

  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: modelRef.modelRef,
        permission: {
          bash: allowEdits ? "allow" : "deny",
          edit: allowEdits ? "allow" : "deny",
          external_directory: "allow",
          webfetch: allowNetwork ? "allow" : "deny",
        },
        provider: {
          [modelRef.providerId]: {
            models: {
              [modelRef.modelName]: {
                name: modelRef.modelName,
                ...(responsesReasoningOptions
                  ? {
                      options: responsesReasoningOptions,
                      variants: getResponsesReasoningVariants(),
                    }
                  : {}),
                ...(modelConfig.modalities
                  ? {
                      modalities: {
                        input: modelConfig.modalities.input,
                        output: modelConfig.modalities.output,
                      },
                    }
                  : {}),
                ...(modelConfig.maxOutputTokens
                  ? {
                      limit: {
                        context:
                          modelConfig.contextWindow ?? 256000,
                        output: modelConfig.maxOutputTokens,
                      },
                    }
                  : {
                      ...(modelConfig.contextWindow
                        ? {
                            limit: {
                              context: modelConfig.contextWindow,
                              output: 32000,
                            },
                          }
                        : {
                            limit: {
                              context: 256000,
                              output: 32000,
                            },
                          }),
                    }),
              },
            },
            name: modelConfig.providerLabel,
            npm: getProviderNpmPackage(modelConfig),
            options: providerOptions,
          },
        },
        mcp: {
          "browser-session": {
            type: "local",
            command: [
              process.execPath,
              path.join(process.cwd(), "dist/browser-mcp-server.mjs"),
              "--scale",
              String(options.deviceScaleFactor ?? 1),
            ],
            enabled: true,
            timeout: 15000,
          },
        },
        tools: {
          apply_patch: allowEdits,
          bash: allowEdits,
          cat: true,
          edit: allowEdits,
          find: true,
          glob: true,
          grep: true,
          head: true,
          list_files: true,
          ls: true,
          read: true,
          read_file: true,
          search_files: true,
          tail: true,
          tree: true,
          view: true,
          webfetch: allowNetwork,
          websearch: allowWebSearch,
          write: allowEdits,
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

const usageFromStepFinish = (
  part: Record<string, unknown> | undefined,
): Usage | null => {
  const tokens = readRecord(part?.tokens);
  if (!tokens) return null;
  const cache = readRecord(tokens.cache);
  const cacheRead = readNumber(cache?.read) ?? 0;
  const cacheWrite = readNumber(cache?.write) ?? 0;
  const input = readNumber(tokens.input) ?? 0;
  const output = readNumber(tokens.output) ?? 0;
  const reasoning = readNumber(tokens.reasoning) ?? 0;
  return {
    cached_input_tokens: cacheRead,
    input_tokens: input + cacheRead + cacheWrite,
    output_tokens: output + reasoning,
  };
};

const extractErrorMessage = (event: OpencodeEvent) => {
  const error = readRecord(event.error);
  const data = readRecord(error?.data);
  return (
    trimToUndefined(readString(data?.message)) ??
    trimToUndefined(readString(error?.message)) ??
    trimToUndefined(readString(data?.ref)) ??
    "OpenCode runtime failed."
  );
};

const extractFileChanges = (metadata: Record<string, unknown> | undefined) =>
  readArray(metadata?.files)
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      kind: mapFileChangeKind(entry.type),
      path:
        readString(entry.filePath) ??
        readString(entry.relativePath) ??
        "unknown",
    }));

const parseTodoItems = (value: unknown) =>
  readArray(value)
    .map((entry) => readRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      completed: Boolean(entry.completed),
      text:
        readString(entry.text) ??
        readString(entry.content) ??
        readString(entry.title) ??
        "",
    }))
    .filter((entry) => entry.text.length > 0);

const buildToolEvents = (toolPart: OpencodeToolPart): AgentThreadEvent[] => {
  const toolName = trimToUndefined(toolPart.tool) ?? "tool";
  const state = readRecord(toolPart.state) ?? {};
  const input = readRecord(state.input) ?? {};
  const metadata = readRecord(state.metadata);
  const status = trimToUndefined(readString(state.status)) ?? "completed";
  const itemId =
    trimToUndefined(toolPart.callID) ??
    trimToUndefined(toolPart.id) ??
    `opencode-tool-${randomUUID()}`;

  if (toolName === "bash") {
    const command = readString(input.command) ?? "";
    const output =
      readString(state.output) ?? readString(metadata?.output) ?? "";
    const exitCode = readNumber(metadata?.exit);
    const finalStatus =
      status === "failed" || (typeof exitCode === "number" && exitCode !== 0)
        ? "failed"
        : status === "in_progress"
          ? "in_progress"
          : "completed";
    const baseItem: AgentThreadItem = {
      aggregated_output: "",
      command,
      id: itemId,
      status: "in_progress",
      type: "command_execution",
    };
    if (finalStatus === "in_progress") {
      return [{ item: baseItem, type: "item.started" }];
    }
    return [
      { item: baseItem, type: "item.started" },
      {
        item: {
          ...baseItem,
          aggregated_output: output,
          exit_code: exitCode,
          status: finalStatus,
        },
        type: "item.completed",
      },
    ];
  }

  if (
    toolName === "apply_patch" ||
    toolName === "edit" ||
    toolName === "write"
  ) {
    const changes = extractFileChanges(metadata);
    const fallbackPath =
      readString(input.path) ??
      readString(input.filePath) ??
      readString(input.target_file);
    return [
      {
        item: {
          changes:
            changes.length > 0
              ? changes
              : fallbackPath
                ? [{ kind: "update", path: fallbackPath }]
                : [],
          id: itemId,
          status: status === "failed" ? "failed" : "completed",
          type: "file_change",
        },
        type: "item.completed",
      },
    ];
  }

  if (toolName === "websearch" || toolName === "webfetch") {
    const query =
      readString(input.query) ??
      readString(input.prompt) ??
      readString(input.url) ??
      toolName;
    return [
      {
        item: {
          id: itemId,
          query,
          type: "web_search",
        },
        type: "item.completed",
      },
    ];
  }

  const todoItems = toolName.toLowerCase().includes("todo")
    ? parseTodoItems(input.todos ?? state.output)
    : [];
  if (todoItems.length > 0) {
    return [
      {
        item: {
          id: itemId,
          items: todoItems,
          type: "todo_list",
        },
        type: "item.completed",
      },
    ];
  }

  const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
  const server = mcpMatch?.[1] ?? "opencode";
  const tool = mcpMatch?.[2] ?? toolName;
  const filePath =
    readString(input.path) ??
    readString(input.filePath) ??
    readString(input.target_file);
  const mcpItem: AgentThreadItem = {
    ...(filePath ? { filePath } : {}),
    id: itemId,
    result: state.output ?? metadata ?? state,
    server,
    status:
      status === "failed"
        ? "failed"
        : status === "in_progress"
          ? "in_progress"
          : "completed",
    tool,
    type: "mcp_tool_call",
  };

  if (mcpItem.status === "in_progress") {
    return [{ item: mcpItem, type: "item.started" }];
  }

  return [
    {
      item: {
        ...mcpItem,
        status: "in_progress",
      },
      type: "item.started",
    },
    { item: mcpItem, type: "item.completed" },
  ];
};

const createTurnMetricsRecorder = ({
  providerTelemetry,
  runtimeTrace,
  runtimeTracePath,
  runtimeTraceSampleChars,
  startedAt,
}: {
  providerTelemetry: ProviderTelemetry;
  runtimeTrace: boolean;
  runtimeTracePath?: string;
  runtimeTraceSampleChars: number;
  startedAt: number;
}) => {
  let firstTextAt: number | undefined;
  let firstTextSample: string | undefined;
  let firstThinkAt: number | undefined;
  let firstThinkSample: string | undefined;
  let textCharCount = 0;
  let textChunkCount = 0;
  let thinkCharCount = 0;
  let thinkChunkCount = 0;
  let chunkIndex = 0;
  let lastChunk: {
    at: number;
    index: number;
    kind: "start" | "text" | "think" | "end";
  } = {
    at: startedAt,
    index: 0,
    kind: "start",
  };
  let maxChunkGapMs = 0;
  const chunkGaps: AgentTurnMetrics["chunkGaps"] = [];
  const thinkSamples: AgentTurnMetrics["thinkSamples"] = [];

  const recordChunk = (
    kind: "text" | "think" | "end",
    at: number,
    chars?: number,
  ) => {
    const nextIndex = kind === "end" ? chunkIndex + 1 : ++chunkIndex;
    const gapMs = Math.max(0, at - lastChunk.at);
    maxChunkGapMs = Math.max(maxChunkGapMs, gapMs);
    chunkGaps.push({
      fromAt: lastChunk.at,
      fromIndex: lastChunk.index,
      fromKind: lastChunk.kind,
      gapMs,
      toAt: at,
      toChars: chars,
      toIndex: nextIndex,
      toKind: kind,
    });
    lastChunk = { at, index: nextIndex, kind };
  };

  return {
    finish(): AgentTurnMetrics {
      const completedAt = Date.now();
      recordChunk("end", completedAt);
      return {
        chunkGaps,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        firstTextAt,
        firstTextDelayMs:
          firstTextAt === undefined ? undefined : firstTextAt - startedAt,
        firstTextSample,
        firstTextSampleChars: firstTextSample?.length,
        firstThinkAt,
        firstThinkDelayMs:
          firstThinkAt === undefined ? undefined : firstThinkAt - startedAt,
        firstThinkSample,
        firstThinkSampleChars: firstThinkSample?.length,
        firstTokenAccurate:
          firstTextAt !== undefined || firstThinkAt !== undefined,
        maxChunkGapMs,
        providerTelemetry,
        runtimeTrace,
        runtimeTracePath,
        source: "opencode",
        startedAt,
        textCharCount,
        textChunkCount,
        thinkCharCount,
        thinkChunkCount,
        thinkSampleChars: runtimeTraceSampleChars,
        thinkSamples,
      };
    },
    recordText(text: string, at: number) {
      if (!text) return;
      recordChunk("text", at, text.length);
      textChunkCount += 1;
      textCharCount += text.length;
      if (firstTextAt !== undefined) return;
      firstTextAt = at;
      firstTextSample = compactSample(text, TEXT_SAMPLE_CHARS);
    },
    recordThink(text: string, at: number) {
      if (!text) return;
      recordChunk("think", at, text.length);
      thinkChunkCount += 1;
      thinkCharCount += text.length;
      const sample = compactSample(text, runtimeTraceSampleChars);
      if (sample && thinkSamples.length < THINK_SAMPLE_RECORD_LIMIT) {
        thinkSamples.push({
          at,
          chars: sample.length,
          delayMs: at - startedAt,
          index: thinkChunkCount,
          text: sample,
        });
      }
      if (firstThinkAt !== undefined) return;
      firstThinkAt = at;
      firstThinkSample = sample;
    },
  };
};

class OpencodeThread implements AgentThread {
  private _id: string | null = null;

  constructor(
    private readonly modelConfig: ModelProviderConfig,
    private readonly options: ThreadOptions,
    threadId?: string,
  ) {
    this._id = threadId ?? null;
  }

  get id() {
    return this._id;
  }

  async runStreamed(
    input: AgentInput,
    turnOptions: { signal?: AbortSignal } = {},
  ): Promise<AgentRunStreamedResult> {
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
    let metrics: AgentTurnMetrics | undefined;
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
      } else if (event.type === "turn.metrics") {
        metrics = event.metrics;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error.message;
        break;
      }
    }

    if (turnFailure) throw new Error(turnFailure);
    return { finalResponse, items, metrics, usage };
  }

  private async *runStreamedInternal(
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

    if (this._id) {
      yield { thread_id: this._id, type: "thread.started" };
    }
    yield { type: "turn.started" };

    const modelRef = resolveOpencodeModelRef(this.modelConfig);
    const providerTelemetry = createProviderTelemetry({
      modelConfig: this.modelConfig,
      modelRef,
    });
    const traceWriter = await createRuntimeTraceWriter({
      modelConfig: this.modelConfig,
      options: this.options,
    });
    const { cleanup, configPath } = await createOpencodeConfigFile({
      modelConfig: this.modelConfig,
      modelRef,
      options: this.options,
    });

    const startedAt = Date.now();
    const metricsRecorder: TurnMetricsRecorder = createTurnMetricsRecorder({
      providerTelemetry,
      runtimeTrace: Boolean(traceWriter),
      runtimeTracePath: traceWriter?.tracePath,
      runtimeTraceSampleChars: this.modelConfig.runtimeTraceSampleChars,
      startedAt,
    });
    const normalizedInput = normalizeInput(input);
    const modelVariant = resolveOpencodeVariant(
      this.options.modelReasoningEffort,
      this.modelConfig,
    );
    const args = [
      "run",
      "--format",
      "json",
      "--pure",
      "--model",
      modelRef.modelRef,
      ...(modelVariant ? ["--variant", modelVariant] : []),
      "--dir",
      this.options.workingDirectory ?? process.cwd(),
      ...(this.modelConfig.thinking ? ["--thinking"] : []),
    ];

    if (this._id) {
      args.push("--session", this._id);
    }
    for (const file of normalizedInput.files) {
      args.push("--file", file);
    }
    if (normalizedInput.files.length > 0) {
      args.push("--");
    }
    args.push(normalizedInput.message);

    const child = spawn(process.env["OPENCODE_CLI_PATH"] ?? "opencode", args, {
      cwd: this.options.workingDirectory ?? process.cwd(),
      env: {
        ...process.env,
        OPENCODE_CONFIG: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    providerTelemetry.childPid = child.pid;

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
      const settle = (value: {
        code: number | null;
        error?: Error;
        signal: string | null;
      }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      childEvents.once("error", (error) =>
        settle({ code: 1, error, signal: null }),
      );
      childEvents.once("exit", (code, signal) => settle({ code, signal }));
    });

    const rl = readline.createInterface({
      crlfDelay: Infinity,
      input: child.stdout,
    });

    let stderr = "";
    let turnFailed: string | null = null;
    let totalUsage: Usage | null = null;
    const finalMessages: string[] = [];
    let abortRequested = false;
    let sawThreadStarted = Boolean(this._id);

    const abort = () => {
      abortRequested = true;
      child.kill("SIGTERM");
    };
    turnOptions.signal?.addEventListener("abort", abort, { once: true });
    if (turnOptions.signal?.aborted) abort();

    child.stderr.on("data", (chunk) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      stderr = appendTailSample(stderr, text);
    });

    try {
      for await (const line of rl) {
        await traceWriter?.writeLine(line);

        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: OpencodeEvent;
        try {
          parsed = JSON.parse(trimmed) as OpencodeEvent;
        } catch {
          stderr = appendTailSample(stderr, `${trimmed}\n`);
          continue;
        }

        if (parsed.sessionID && (!this._id || !sawThreadStarted)) {
          this._id = parsed.sessionID;
          sawThreadStarted = true;
          yield { thread_id: parsed.sessionID, type: "thread.started" };
        }

        if (parsed.type === "error") {
          const message = extractErrorMessage(parsed);
          providerTelemetry.errorMessages.push(message);
          providerTelemetry.errorBodies.push(trimmed);
          yield { message, type: "error" };
          turnFailed = turnFailed ?? message;
          continue;
        }

        if (parsed.type === "tool_use") {
          const part = readRecord(parsed.part) as OpencodeToolPart | undefined;
          if (part) {
            for (const event of buildToolEvents(part)) {
              yield event;
            }
          }
          continue;
        }

        if (parsed.type === "reasoning") {
          const part = readRecord(parsed.part);
          const text = readString(part?.text) ?? "";
          if (!text) continue;
          const at = readNumber(parsed.timestamp) ?? Date.now();
          metricsRecorder.recordThink(text, at);
          const reasoningText = truncateReasoningForEvent(text);
          if (reasoningText) {
            yield {
              item: {
                id: `opencode-reasoning-${randomUUID()}`,
                text: reasoningText,
                type: "reasoning",
              },
              type: "item.completed",
            };
          }
          continue;
        }

        if (parsed.type === "text") {
          const part = readRecord(parsed.part);
          const text = readString(part?.text) ?? "";
          if (!text) continue;
          const at = readNumber(parsed.timestamp) ?? Date.now();
          metricsRecorder.recordText(text, at);
          finalMessages.push(text);
          continue;
        }

        if (parsed.type === "step_finish") {
          totalUsage = accumulateUsage(
            totalUsage,
            usageFromStepFinish(readRecord(parsed.part)),
          );
        }
      }
    } finally {
      rl.close();
      turnOptions.signal?.removeEventListener("abort", abort);
    }

    const exit = await exitPromise;
    providerTelemetry.exitCode = exit.code;
    providerTelemetry.exitSignal = exit.signal;
    providerTelemetry.stderrTail = trimToUndefined(stderr);

    await cleanup();

    if (abortRequested || turnOptions.signal?.aborted) {
      turnFailed = `aborted: ${String(turnOptions.signal?.reason ?? "aborted")}`;
    } else if (exit.error) {
      turnFailed = `Failed to start OpenCode CLI: ${exit.error.message}`;
    } else if (exit.code !== 0 || exit.signal) {
      turnFailed =
        trimToUndefined(stderr) ??
        `OpenCode CLI exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`}`;
    }

    const metrics = metricsRecorder.finish();

    if (turnFailed) {
      yield { metrics, type: "turn.metrics" };
      yield {
        error: { message: turnFailed },
        type: "turn.failed",
      };
      return;
    }

    yield {
      item: createAgentMessageItem(finalMessages.join("")),
      type: "item.completed",
    };
    yield { metrics, type: "turn.metrics" };
    yield {
      type: "turn.completed",
      usage:
        totalUsage ??
        ({
          cached_input_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        } satisfies Usage),
    };
  }
}

const createOpencodeRuntime = (
  modelConfig: ModelProviderConfig,
): AgentRuntime => ({
  resumeThread(id: string, options?: ThreadOptions) {
    return new OpencodeThread(modelConfig, options ?? {}, id);
  },
  startThread(options?: ThreadOptions) {
    return new OpencodeThread(modelConfig, options ?? {});
  },
});

export { createOpencodeRuntime };
