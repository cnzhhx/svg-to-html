import { MODEL_CONFIG } from "../config/model-provider.js";
import { agentRuntime } from "./agent-runtime/index.js";
import type { ThreadOptions } from "./agent-runtime/index.js";

const threadOptions: ThreadOptions = {
  // 不走人工审批流；代理在执行命令或改文件时不会停下来等待确认。
  approvalPolicy: "never",
  // 本轮线程默认使用的模型名称。
  model: MODEL_CONFIG.model,
  // 控制模型推理强度；xhigh 是这版 SDK 暴露的最高档，速度更慢、成本更高，但复杂任务更稳。
  modelReasoningEffort: MODEL_CONFIG.reasoningEffort,
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
};

const startAgentThread = (options: ThreadOptions = {}) =>
  agentRuntime.startThread(options);

const runLlm = async (prompt: string): Promise<string> => {
  const thread = startAgentThread(threadOptions);
  const turn = await thread.run(prompt);
  return turn.finalResponse ?? "";
};

const runVisionLlm = async ({
  imagePath,
  prompt,
}: {
  imagePath: string;
  prompt: string;
}): Promise<string> => {
  const thread = startAgentThread(threadOptions);
  const turn = await thread.run([
    { type: "text", text: prompt },
    { type: "local_image", path: imagePath },
  ]);
  return turn.finalResponse ?? "";
};

export { MODEL_CONFIG, runLlm, runVisionLlm, startAgentThread, threadOptions };
