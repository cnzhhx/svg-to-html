import type { ThreadOptions } from "../../agent-runtime/index.js";
import { getModuleAgentCoordinatorConfig } from "../../../config/index.js";
import type { ModuleSemanticDocument } from "./module-semantic.js";

type ModuleAgentCoordinatorDecision = {
  enabled: boolean;
  jsonBytes: number;
  jsonBytesThreshold: number;
  nodeCount: number;
  nodeThreshold: number;
  reason: "disabled" | "json-bytes" | "nodes" | "nodes-and-json-bytes" | "none";
};

type ModuleAgentCoordinatorInput = {
  config?: {
    enabled: boolean;
    jsonBytesThreshold: number;
    nodeThreshold: number;
  };
  jsonBytes: number;
  moduleSemantic: Pick<ModuleSemanticDocument, "nodes">;
};

type OpencodeAgentConfig = NonNullable<ThreadOptions["opencodeAgents"]>[string];

const MODULE_COORDINATOR_SUBAGENT_NAMES = ["module-analysis"] as const;

const buildReadOnlySubagentConfig = ({
  description,
  prompt,
}: {
  description: string;
  prompt: string;
}): OpencodeAgentConfig => ({
  description,
  mode: "subagent",
  prompt,
  steps: 6,
  tools: {
    bash: false,
    edit: false,
    glob: true,
    grep: true,
    read: true,
    skill: false,
    task: false,
    todowrite: false,
    webfetch: false,
    websearch: false,
    write: false,
  },
});

const buildModuleCoordinatorSubagents = (): ThreadOptions["opencodeAgents"] => ({
  "module-analysis": buildReadOnlySubagentConfig({
    description:
      "Read-only module analysis subagent for parent-chosen focused questions. Return JSON only.",
    prompt: `
You are a read-only module analysis subagent.

Follow the parent Task prompt exactly. Analyze one focused question about the module and return JSON only.

Stay read-only:
- You may read/glob/grep the files allowed by the parent prompt.
- Do not write files, edit files, export assets, run browser tools, run verify, run shell commands, or start more tasks.
- If the prompt is too broad, narrow it to the single highest-value answer and include a warning.

Return a compact JSON object such as:
{ "topic": "", "confidence": 0.0, "findings": [], "outputs": {}, "warnings": [] }
`.trim(),
  }),
});

const resolveModuleAgentCoordinatorDecision = ({
  config: inputConfig,
  jsonBytes,
  moduleSemantic,
}: ModuleAgentCoordinatorInput): ModuleAgentCoordinatorDecision => {
  const config = inputConfig ?? getModuleAgentCoordinatorConfig();
  const nodeCount = moduleSemantic.nodes.length;
  const byNodes = nodeCount >= config.nodeThreshold;
  const byJsonBytes = jsonBytes >= config.jsonBytesThreshold;
  const enabled = config.enabled && (byNodes || byJsonBytes);
  const reason = !config.enabled
    ? "disabled"
    : byNodes && byJsonBytes
      ? "nodes-and-json-bytes"
      : byNodes
        ? "nodes"
        : byJsonBytes
          ? "json-bytes"
          : "none";

  return {
    enabled,
    jsonBytes,
    jsonBytesThreshold: config.jsonBytesThreshold,
    nodeCount,
    nodeThreshold: config.nodeThreshold,
    reason,
  };
};

const buildModuleCoordinatorPromptSection = (
  decision: ModuleAgentCoordinatorDecision,
) => {
  if (!decision.enabled) return "";
  const jsonKb = (decision.jsonBytes / 1024).toFixed(1);
  const thresholdKb = (decision.jsonBytesThreshold / 1024).toFixed(1);

  return `
## 大模块 coordinator planning phase
本模块触发大模块协调模式：nodes=${decision.nodeCount}/${decision.nodeThreshold}, module-semantic.json=${jsonKb}KB/${thresholdKb}KB, reason=${decision.reason}。

这不是固定拆法；你负责判断是否值得拆、怎么拆。

在写任何文件、导出任何资产、运行 browser-eval 或 verify 之前，先做一个很短的规划判断：
- 当前模块最不确定或最耗时的 2-4 个问题是什么。
- 哪些问题适合交给 Task subagent 独立并行分析。
- 哪些问题你自己直接处理更快。

如果你判断 subagent 不会带来收益，可以不用，直接继续实现。

如果使用 subagent：
- 使用 opencode Task 工具，subagent_type 选 module-analysis。
- 任务数量由你决定，建议 1-4 个；只拆真正独立的问题，不要为了凑数拆。
- 先连续发起彼此独立的 Task，再合并结果；不要让一个子任务依赖另一个子任务的输出。
- 每个 Task prompt 目标单一，由你定义分析主题和返回格式。
- 每个 Task prompt 必须包含模块工作目录、module-semantic.json 路径，并说明本 prompt 末尾已经预加载精简版 module-semantic.json，可直接基于当前上下文分析。
- 如果子任务需要读文件，只允许读取 module-semantic.json、preview.fragment.html、module.css、manifest.json 和 assets 目录清单；不要读取 module.svg、analysis-sheets、module-semantic.debug.json。
- 子任务只返回 JSON，不写文件、不导出资产、不运行 browser 工具、不运行 verify、不继续启动子任务。

合并规则：
- 子任务输出只是参考，不是最终策略；最终布局、资产导出、文本处理和 CSS 决策由你负责。
- 如果 Task 失败、输出不完整、或拆分收益不明显，记录 warning 后按原流程继续，不要卡住。
`.trim();
};

export {
  MODULE_COORDINATOR_SUBAGENT_NAMES,
  buildModuleCoordinatorPromptSection,
  buildModuleCoordinatorSubagents,
  resolveModuleAgentCoordinatorDecision,
};
export type { ModuleAgentCoordinatorDecision };
