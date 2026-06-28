import {
  resolveModelConfigForRole,
} from "../config/model-provider.js";
import type {
  ModelConfigRole,
  ModelProviderConfig,
} from "../config/model-provider.js";
import { getAgentRuntime } from "./agent-runtime/index.js";
import type {
  AgentInput,
  AgentRunStreamedResult,
  AgentThread,
  AgentTurnMetrics,
  AgentTurn,
  ThreadOptions,
} from "./agent-runtime/index.js";
import { AGENT_REASONING_EFFORTS } from "../config/agent-reasoning.js";
import { recordModelUsage } from "./model-usage.js";

const createThreadOptions = (
  modelConfig: Pick<ModelProviderConfig, "model" | "reasoningEffort">,
): ThreadOptions => ({
  // 不走人工审批流；代理在执行命令或改文件时不会停下来等待确认。
  approvalPolicy: "never",
  // 本轮线程默认使用的模型名称。
  model: modelConfig.model,
  // 控制模型推理强度；xhigh 是这版 SDK 暴露的最高档，速度更慢、成本更高，但复杂任务更稳。
  modelReasoningEffort: modelConfig.reasoningEffort,
  // 允许代理在运行中访问网络资源。
  networkAccessEnabled: true,
  // 给予代理高权限沙箱能力，基本等同于不受限地访问工作目录与执行命令。
  sandboxMode: "danger-full-access",
  // 跳过 Git 仓库信任检查，避免因为目录未被标记为 trusted 而直接拒绝执行。
  skipGitRepoCheck: true,
  // 打开网页搜索能力，代理可以使用内置 web search。
  webSearchEnabled: true,
  // 使用实时搜索，不只读缓存结果。
  webSearchMode: "live",
});

const getThreadOptions = (modelRole: ModelConfigRole = "text") =>
  createThreadOptions(resolveModelConfigForRole(modelRole));

const applyThreadOptionDefaults = (
  modelConfig: ModelProviderConfig,
  options: ThreadOptions,
): ThreadOptions => ({
  ...createThreadOptions(modelConfig),
  ...options,
  model: modelConfig.model,
  modelReasoningEffort:
    options.modelReasoningEffort ?? modelConfig.reasoningEffort,
});

const trackThreadUsage = ({
  modelConfig,
  modelRole,
  source,
  thread,
}: {
  modelConfig: ModelProviderConfig;
  modelRole: ModelConfigRole;
  source?: string;
  thread: AgentThread;
}): AgentThread => ({
  get id() {
    return thread.id;
  },

  async run(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentTurn> {
    const turn = await thread.run(input, turnOptions);
    recordModelUsage({
      inputKind: getInputKind(input),
      metrics: turn.metrics,
      modelConfig,
      modelRole,
      source,
      threadId: thread.id,
      usage: turn.usage,
    });
    return turn;
  },

  async runStreamed(
    input: AgentInput,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<AgentRunStreamedResult> {
    const streamed = await thread.runStreamed(input, turnOptions);
    return {
      events: (async function* () {
        let metrics: AgentTurnMetrics | undefined;
        for await (const event of streamed.events) {
          if (event.type === "turn.metrics") {
            metrics = event.metrics;
          }
          if (event.type === "turn.completed") {
            recordModelUsage({
              inputKind: getInputKind(input),
              metrics,
              modelConfig,
              modelRole,
              source,
              threadId: thread.id,
              usage: event.usage,
            });
          }
          yield event;
        }
      })(),
    };
  },
});

const getInputKind = (input: AgentInput) =>
  Array.isArray(input) && input.some((item) => item.type === "local_image")
    ? "vision"
    : "text";

const startAgentThread = (
  options: ThreadOptions = {},
  input: {
    modelRole?: ModelConfigRole;
    source?: string;
  } = {},
) => {
  const modelRole = input.modelRole ?? "text";
  const modelConfig = resolveModelConfigForRole(modelRole);
  const runtime = getAgentRuntime(modelConfig);
  return trackThreadUsage({
    modelConfig,
    modelRole,
    source: input.source,
    thread: runtime.startThread(
      applyThreadOptionDefaults(modelConfig, options),
    ),
  });
};

const resumeAgentThread = (
  id: string,
  options: ThreadOptions = {},
  input: {
    modelRole?: ModelConfigRole;
    source?: string;
  } = {},
) => {
  const modelRole = input.modelRole ?? "text";
  const modelConfig = resolveModelConfigForRole(modelRole);
  const runtime = getAgentRuntime(modelConfig);
  return trackThreadUsage({
    modelConfig,
    modelRole,
    source: input.source,
    thread: runtime.resumeThread(
      id,
      applyThreadOptionDefaults(modelConfig, options),
    ),
  });
};

const runLlm = async (prompt: string): Promise<string> => {
  const thread = startAgentThread(
    {
      modelReasoningEffort: AGENT_REASONING_EFFORTS.support,
    },
    { modelRole: "text" },
  );
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? "";
};

const runVisionLlm = async ({
  imagePath,
  prompt,
  runtimeTraceDir,
  runtimeTraceLabel,
  signal,
}: {
  imagePath: string;
  prompt: string;
  runtimeTraceDir?: string;
  runtimeTraceLabel?: string;
  signal?: AbortSignal;
}): Promise<string> => {
  const thread = startAgentThread(
    {
      modelReasoningEffort: AGENT_REASONING_EFFORTS.support,
      runtimeTraceDir,
      runtimeTraceLabel,
    },
    { modelRole: "vision" },
  );
  const turn = await thread.run(
    [
      { type: "text", text: prompt },
      { type: "local_image", path: imagePath },
    ],
    { signal },
  );
  return turn.finalResponse ?? "";
};

export {
  getThreadOptions,
  resumeAgentThread,
  runLlm,
  runVisionLlm,
  startAgentThread,
};
