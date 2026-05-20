import path from "node:path";

import { AGENT_REASONING_EFFORTS } from "../../config/agent-reasoning.js";
import type { DesignPair } from "../../core/utils.js";
import { sessionStore } from "../../session-store.js";
import { startAgentThread, threadOptions } from "../llm-client.js";
import type { VerifyResult } from "../verify/types.js";
import {
  archiveAgentTurn,
  completeAgentTurnWithUsage,
} from "./agent-result.js";
import { getInitialPrompt } from "./prompts.js";
import { runAgentTurnCore } from "./agent-turn-core.js";

const buildGlobalRepairPrompt = ({
  artifactDir,
  design,
  hardFailures,
  modulePlanPath,
  scaffoldHtmlPath,
  verifyResult,
}: {
  artifactDir: string;
  design: DesignPair;
  hardFailures: string[];
  modulePlanPath: string;
  scaffoldHtmlPath: string;
  verifyResult: VerifyResult;
}) =>
  `
${getInitialPrompt({
  artifactDir,
  compareHtmlPath: design.compareHtmlPath,
  htmlPath: design.htmlPath,
  multiAgentRoute: true,
  scale: design.scale,
  svgPath: design.svgPath,
})}

---

## 1-shot Global Repair

模块流水线已经完成并合并到最终 HTML。你只做一次全局修复，目标是处理硬 gate，不要从零重写页面，也不要重做局部模块细节。

硬 gate:
${hardFailures.map((failure) => `- ${failure}`).join("\n")}

关键报告:
- verify report: ${verifyResult.verifyReportPath}
- final HTML: ${design.htmlPath}
- SVG: ${design.svgPath}
- module plan: ${modulePlanPath}
- scaffold snapshot: ${scaffoldHtmlPath}

可复现要求：
- 最终 HTML 不是源头，模块片段才是源头。
- 如果修复某个模块，请同步修改对应的 \`modules/<id>/fragment.html\`、\`fragment.css\`、\`text-layout.json\` 或 \`manifest.json\`。
- 如果修复全局 head/style/scaffold 问题，请同步修改 scaffold snapshot。
- 宿主流程会在你完成后重新 deterministic merge；只改 final HTML 的修复会被覆盖。

完成后不要运行 verify-design；宿主流程会立即执行最终 full verify。
`.trim();

const runGlobalRepairTurn = async ({
  artifactDir,
  controller,
  design,
  hardFailures,
  modulePlanPath,
  round,
  scaffoldHtmlPath,
  sessionId,
  verifyResult,
}: {
  artifactDir: string;
  controller: AbortController;
  design: DesignPair;
  hardFailures: string[];
  modulePlanPath: string;
  round: number;
  scaffoldHtmlPath: string;
  sessionId: string;
  verifyResult: VerifyResult;
}) => {
  sessionStore.startWorkflowNode(sessionId, "agent", {
    detail: "正在执行一次全局硬 gate 修复",
    iteration: round,
  });
  sessionStore.startStep(sessionId, "agent");
  sessionStore.addLog(
    sessionId,
    `[global-repair] starting 1-shot repair: ${hardFailures.join("; ")}`,
  );

  const thread = startAgentThread({
    ...threadOptions,
    workingDirectory: process.cwd(),
    additionalDirectories: [path.dirname(design.svgPath), artifactDir],
    modelReasoningEffort: AGENT_REASONING_EFFORTS.globalRepair,
  });
  const turn = await runAgentTurnCore({
    controller,
    prompt: buildGlobalRepairPrompt({
      artifactDir,
      design,
      hardFailures,
      modulePlanPath,
      scaffoldHtmlPath,
      verifyResult,
    }),
    round,
    sessionId,
    thread,
  });

  await archiveAgentTurn({
    designHtmlPath: design.htmlPath,
    finalResponse: turn.finalResponse,
    note: `Global repair turn ${round} completed`,
    round,
    sessionId,
    turnSummary: turn.turnSummary,
    usage: turn.usage,
  });
  completeAgentTurnWithUsage({
    compareHtmlPath: design.compareHtmlPath,
    finalResponse: turn.finalResponse,
    hasCompletedAgentMessage: turn.hasCompletedAgentMessage,
    htmlPath: design.htmlPath,
    sessionId,
    usage: turn.usage,
  });
  sessionStore.completeWorkflowNode(
    sessionId,
    "agent",
    "全局硬 gate 修复已完成",
  );
};

export { runGlobalRepairTurn };
