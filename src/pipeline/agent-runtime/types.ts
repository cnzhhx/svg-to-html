type CommandExecutionStatus = "in_progress" | "completed" | "failed";
type PatchChangeKind = "add" | "delete" | "update";
type PatchApplyStatus = "completed" | "failed";

type Usage = {
  cached_input_tokens?: number;
  input_tokens: number;
  output_tokens: number;
};

type AgentTurnMetrics = {
  chunkGaps: Array<{
    fromAt: number;
    fromIndex: number;
    fromKind: "start" | "text" | "think" | "end";
    gapMs: number;
    toAt: number;
    toChars?: number;
    toIndex: number;
    toKind: "text" | "think" | "end";
  }>;
  completedAt: number;
  durationMs: number;
  firstTextAt?: number;
  firstTextDelayMs?: number;
  firstTextSample?: string;
  firstTextSampleChars?: number;
  firstThinkAt?: number;
  firstThinkDelayMs?: number;
  firstThinkSample?: string;
  firstThinkSampleChars?: number;
  firstTokenAccurate: boolean;
  maxChunkGapMs?: number;
  providerTelemetry?: {
    baseURL?: string;
    childPid?: number;
    errorBodies: string[];
    errorMessages: string[];
    exitCode?: number | null;
    exitSignal?: string | null;
    httpStatusCodes: number[];
    localCancelId?: string;
    localPromptId?: string;
    model?: string;
    provider?: string;
    providerRequestIds: string[];
    retryCount: number;
    retryEvents: string[];
    stderrTail?: string;
  };
  runtimeTrace?: boolean;
  runtimeTracePath?: string;
  source: "opencode";
  startedAt: number;
  textCharCount: number;
  textChunkCount: number;
  thinkCharCount: number;
  thinkChunkCount: number;
  thinkSampleChars: number;
  thinkSamples: Array<{
    at: number;
    chars: number;
    delayMs: number;
    index: number;
    text: string;
  }>;
};

type ThreadOptions = {
  additionalDirectories?: string[];
  approvalPolicy?: string;
  deviceScaleFactor?: number;
  model?: string;
  modelReasoningEffort?: string;
  networkAccessEnabled?: boolean;
  runtimeTraceDir?: string;
  runtimeTraceLabel?: string;
  sandboxMode?: "read-only" | "danger-full-access" | string;
  skipGitRepoCheck?: boolean;
  webSearchEnabled?: boolean;
  webSearchMode?: string;
  workingDirectory?: string;
};

type AgentThreadItem =
  | {
      id: string;
      type: "agent_message";
      text: string;
    }
  | {
      aggregated_output: string;
      command: string;
      exit_code?: number;
      id: string;
      status: CommandExecutionStatus;
      type: "command_execution";
    }
  | {
      changes: Array<{ kind: PatchChangeKind; path: string }>;
      id: string;
      status: PatchApplyStatus;
      type: "file_change";
    }
  | {
      id: string;
      text: string;
      type: "reasoning";
    }
  | {
      id: string;
      message: string;
      type: "error";
    }
  | {
      id: string;
      items: Array<{ completed: boolean; text: string }>;
      type: "todo_list";
    }
  | {
      id: string;
      query: string;
      type: "web_search";
    }
  | {
      error?: { message: string };
      filePath?: string;
      id: string;
      result?: unknown;
      server: string;
      status: "in_progress" | "completed" | "failed";
      tool: string;
      type: "mcp_tool_call";
    };

type AgentThreadEvent =
  | { thread_id: string; type: "thread.started" }
  | { type: "turn.started" }
  | { metrics: AgentTurnMetrics; type: "turn.metrics" }
  | { type: "turn.completed"; usage: Usage }
  | { error: { message: string }; type: "turn.failed" }
  | { item: AgentThreadItem; type: "item.started" }
  | { item: AgentThreadItem; type: "item.updated" }
  | { item: AgentThreadItem; type: "item.completed" }
  | { message: string; type: "error" };

type AgentInput =
  | string
  | Array<
      { text: string; type: "text" } | { path: string; type: "local_image" }
    >;

type AgentTurn = {
  finalResponse: string;
  items: AgentThreadItem[];
  metrics?: AgentTurnMetrics;
  usage: Usage | null;
};

type AgentRunStreamedResult = {
  events: AsyncGenerator<AgentThreadEvent>;
};

type AgentThread = {
  readonly id: string | null;
  run(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentTurn>;
  runStreamed(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentRunStreamedResult>;
};

type AgentRuntime = {
  resumeThread(id: string, options?: ThreadOptions): AgentThread;
  startThread(options?: ThreadOptions): AgentThread;
};

export type {
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
};
