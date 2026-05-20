import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import type { AgentReasoningEffort } from "../../config/agent-reasoning.js";
import type { DesignPair } from "../../core/utils.js";
import { sessionStore } from "../../session-store.js";
import type { AgentThread } from "../agent-runtime/index.js";
import { startAgentThread, threadOptions } from "../llm-client.js";
import { runAgentTurnCore } from "./agent-turn-core.js";
import type {
  SvgVerticalModule,
  SvgVerticalModuleReport,
} from "../../core/svg-vertical-modules/types.js";

type AgentUnitInput = {
  module: SvgVerticalModule;
  moduleSvgPath: string; // 裁切后的模块 SVG（agent 主要看这个）
  originalSvgPath: string; // 原始完整 SVG（用于参考）
  design: DesignPair;
  workingDir: string; // 该模块的独立工作目录 modules/<id>/
  scaffoldHtmlPath: string; // 共享只读 scaffold 底版
  artifactDir: string;
  modulePlan: SvgVerticalModuleReport;
  reasoningEffort: AgentReasoningEffort;
  sessionId: string;
  controller: AbortController;
  feedbackPrompt?: string; // 可选的 feedback prompt（如果是 feedback 轮）
  round?: number;
  thread?: AgentThread;
};

type AgentUnitThreadInput = {
  artifactDir: string;
  moduleSvgPath: string;
  originalSvgPath: string;
  reasoningEffort: AgentReasoningEffort;
  workingDir: string;
};

type AgentUnitResult = {
  success: boolean;
  durationMs: number;
  endedAt: number;
  finalDiffRatio?: number;
  feedbackRounds: number;
  outputByteSizes: {
    fragmentCss: number;
    fragmentHtml: number;
    manifest: number;
    textLayout: number;
  };
  threadId: string;
  promptKind: "initial" | "feedback";
  round: number;
  startedAt: number;
  turnSummary: {
    durationMs: number;
    earlyStopReason?: string;
    internalDiffTimeline: Array<{ diffRatio: number; round: number }>;
    totalCommands: number;
    totalInternalRounds: number;
    totalShellCommands?: number;
    verifyCount: number;
  };
  usage: null | { input_tokens: number; output_tokens: number };
  outputFiles: {
    fragmentHtml: string;
    fragmentCss: string;
    textLayout: string;
    manifest: string;
  };
  outputPaths: {
    fragmentCss: string;
    fragmentHtml: string;
    manifest: string;
    moduleSvg: string;
    textLayout: string;
  };
};

const readFileSize = async (filePath: string) => (await stat(filePath)).size;

const createAgentUnitThread = ({
  artifactDir,
  moduleSvgPath,
  originalSvgPath,
  reasoningEffort,
  workingDir,
}: AgentUnitThreadInput) =>
  startAgentThread({
    ...threadOptions,
    workingDirectory: workingDir,
    additionalDirectories: [
      path.join(path.dirname(originalSvgPath), "assets"),
      path.dirname(moduleSvgPath),
      artifactDir,
    ].filter((dir) => existsSync(dir)),
    modelReasoningEffort: reasoningEffort,
  });

/**
 * 统一的 agent 执行单元
 *
 * 为单个模块执行一次 agent turn（初始生成或 feedback）。
 * Feedback 循环由上层（module-pipeline-v2）管理。
 *
 * 核心能力（继承自 runAgentTurnCore）：
 * - Thread 管理（可复用已有 thread）
 * - Stall 检测 + early stop
 * - Archive checkpoint
 */
export async function runAgentUnit(
  input: AgentUnitInput,
): Promise<AgentUnitResult> {
  const {
    module,
    moduleSvgPath,
    originalSvgPath,
    design,
    workingDir,
    artifactDir,
    modulePlan,
    reasoningEffort,
    sessionId,
    controller,
    feedbackPrompt,
    round = 1,
    thread: inputThread,
  } = input;

  const thread =
    inputThread ??
    createAgentUnitThread({
      artifactDir,
      moduleSvgPath,
      originalSvgPath,
      reasoningEffort,
      workingDir,
    });

  sessionStore.addLog(
    sessionId,
    `[agent-unit:${module.id}] starting with thread ${thread.id ?? "unknown"}, workingDir=${path.relative(process.cwd(), workingDir)}`,
  );

  const startedAt = Date.now();
  const promptKind = feedbackPrompt ? "feedback" : "initial";
  const feedbackRounds = feedbackPrompt ? 1 : 0;
  let finalDiffRatio: number | undefined;
  // 构造 prompt（初始或 feedback）
  const prompt = feedbackPrompt
    ? `${buildAgentUnitPrompt({
        module,
        moduleSvgPath,
        design,
        modulePlan,
        workingDir,
      })}\n\n${feedbackPrompt}`
    : buildAgentUnitPrompt({
        module,
        moduleSvgPath,
        design,
        modulePlan,
        workingDir,
      });

  const turn = await runAgentTurnCore({
    thread,
    prompt,
    round,
    sessionId,
    controller,
    updateSessionThread: false,
  });

  sessionStore.addLog(
    sessionId,
    `[agent-unit:${module.id}] turn completed: ${turn.turnSummary.totalCommands} commands, ${(turn.turnSummary.durationMs / 1000).toFixed(1)}s`,
  );

  // 读取输出文件
  const fragmentHtmlPath = path.join(workingDir, "fragment.html");
  const fragmentCssPath = path.join(workingDir, "fragment.css");
  const textLayoutPath = path.join(workingDir, "text-layout.json");
  const manifestPath = path.join(workingDir, "manifest.json");

  const [fragmentHtml, fragmentCss, textLayout, manifest] = await Promise.all([
    readFile(fragmentHtmlPath, "utf8"),
    readFile(fragmentCssPath, "utf8"),
    readFile(textLayoutPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const [fragmentHtmlSize, fragmentCssSize, textLayoutSize, manifestSize] =
    await Promise.all([
      readFileSize(fragmentHtmlPath),
      readFileSize(fragmentCssPath),
      readFileSize(textLayoutPath),
      readFileSize(manifestPath),
    ]);
  const endedAt = Date.now();

  return {
    success: true,
    durationMs: endedAt - startedAt,
    endedAt,
    finalDiffRatio,
    feedbackRounds,
    outputByteSizes: {
      fragmentCss: fragmentCssSize,
      fragmentHtml: fragmentHtmlSize,
      manifest: manifestSize,
      textLayout: textLayoutSize,
    },
    threadId: thread.id ?? "unknown",
    promptKind,
    round,
    startedAt,
    turnSummary: {
      durationMs: turn.turnSummary.durationMs,
      earlyStopReason: turn.turnSummary.earlyStopReason,
      internalDiffTimeline: turn.turnSummary.internalRounds
        .filter((internalRound) => internalRound.diffRatio !== undefined)
        .map((internalRound) => ({
          diffRatio: internalRound.diffRatio!,
          round: internalRound.roundNumber,
        })),
      totalCommands: turn.turnSummary.totalCommands,
      totalInternalRounds: turn.turnSummary.totalInternalRounds,
      totalShellCommands: turn.turnSummary.totalShellCommands,
      verifyCount: turn.turnSummary.verifyUsage.verifyCount,
    },
    usage: turn.usage,
    outputFiles: {
      fragmentHtml,
      fragmentCss,
      textLayout,
      manifest,
    },
    outputPaths: {
      fragmentCss: fragmentCssPath,
      fragmentHtml: fragmentHtmlPath,
      manifest: manifestPath,
      moduleSvg: moduleSvgPath,
      textLayout: textLayoutPath,
    },
  };
}

/**
 * 构造模块 agent 的初始 prompt
 */
function buildAgentUnitPrompt(input: {
  module: SvgVerticalModule;
  moduleSvgPath: string;
  design: DesignPair;
  modulePlan: SvgVerticalModuleReport;
  workingDir: string;
}): string {
  const { module, moduleSvgPath, design, modulePlan, workingDir } = input;
  const region = module.region;
  const fragmentHtmlPath = path.join(workingDir, "fragment.html");
  const moduleVerifyCliPath = path.join(
    process.cwd(),
    "src/cli/verify-module-design.ts",
  );
  const moduleInspectCliPath = path.join(
    process.cwd(),
    "src/cli/inspect-module-svg.ts",
  );
  const moduleExportCliPath = path.join(
    process.cwd(),
    "src/cli/export-svg-node-asset.ts",
  );
  const moduleInputSummaryPath = path.join(
    workingDir,
    "module-input-summary.md",
  );
  const moduleInputSummaryJsonPath = path.join(
    workingDir,
    "module-input-summary.json",
  );
  const moduleTextStyleHintsPath = path.join(
    workingDir,
    "module-text-style-hints.json",
  );
  const scale =
    typeof design.scale === "number" &&
    Number.isFinite(design.scale) &&
    design.scale > 0
      ? design.scale
      : 1;
  const scaleLabel = Number.isInteger(scale) ? `${scale}` : scale.toFixed(3);
  const moduleSharedLayers = (modulePlan.sharedLayers ?? []).filter((layer) => {
    const layerRegion = layer.region;
    if (!layerRegion) return false;
    return (
      layerRegion.x < region.x + region.width &&
      layerRegion.x + layerRegion.width > region.x &&
      layerRegion.y < region.y + region.height &&
      layerRegion.y + layerRegion.height > region.y
    );
  });
  const sharedLayerSection = moduleSharedLayers.length
    ? `
## 共享背景/透明区域
- 本模块会和共享页面层一起做局部校验并在最终页面合并；这些共享层不属于任何单个模块的 fragment 输出
- 相关共享层：${moduleSharedLayers
        .map(
          (layer) =>
            `${layer.id}:${layer.kind} region=${layer.region.x},${layer.region.y},${layer.region.width},${layer.region.height}${layer.svgPath ? ` path=${layer.svgPath}` : layer.relativePath ? ` path=${layer.relativePath}` : ""}`,
        )
        .join("；")}
- 如果 \`module.svg\` 的某块区域是透明的，而局部校验 target 里显示的是 \`shared-underlay\`，让共享底图透出来；不要为了填透明区域给 \`.${module.id}\`、\`[data-module-id="${module.id}"]\`、根容器或全模块 wrapper 加黑色/白色/不透明大背景
- 允许还原本模块自己拥有的背景节点，例如有明确边界的面板、卡片、按钮、局部装饰或 \`module.svg\` 中实际存在的形状；这些背景只能覆盖它自己的节点范围，不能拿来补整块透明区域
- 若局部 target 中看到跨模块底图，优先视为共享层负责，fragment 保持透明并把本模块内容叠在其上
`
    : "";
  return `
你是模块化还原流水线中的局部 agent。你只负责一个模块，不是整页 agent。

## 最高优先级输出规则
- 只写本模块目录里的产物，不要修改最终 HTML、compare HTML 或其他模块
- \`${fragmentHtmlPath}\` 必须是 HTML 片段，禁止出现 \`html\`、\`head\`、\`body\`、\`main\` 标签
- 禁止生成完整文档，禁止把 fragment 包成页面根节点
- 禁止引用、内联、裁剪或重新打包原始完整 SVG
- 禁止使用 \`data:image/*\` 或 base64
- 普通 UI 文案必须是真实 DOM 文本
- 文本节点和文本容器禁止用 transform/scale/matrix/skew 校准几何
- 禁止用 CSS/HTML/伪元素/border/box-shadow/clip-path 手画 icon、渐变、滤镜、复杂装饰、logo 或艺术字；这类视觉元素必须从 \`module.svg\` 定位对应 SVG 节点，导出模块局部 PNG 后引用
- 从 SVG 节点生成模块局部 PNG 时，必须使用官方 \`export-svg-node-asset\` 命令从当前模块 \`module.svg\` 的指定节点透明导出；不要临时手写 Chrome/PIL/截图裁剪脚本
- 导出 SVG 节点资产时必须追加当前 session 的显式倍率 \`--scale ${scaleLabel}\`；CSS 尺寸和 manifest box 仍使用渲染后的局部坐标，不要用 PNG 文件自身像素尺寸反推布局
- 单个 SVG 节点（包括承载子路径的共同父 \`g\` / \`use\`）可以作为原子 PNG 资产使用；如果这个节点只是普通文本/标签/数值且没有装饰、logo、艺术字形或图形效果绑定，必须改成 DOM 文本，不能切图
- 不要把多个没有共同父级的 SVG sibling 节点拼成一个普通 icon/控件资产；唯一例外是这些节点共同构成不可拆的艺术字、品牌字形或强装饰视觉文字，并且必须在 manifest 中声明视觉文字用途和 textTreatment
- 使用任何自生成 PNG 前，先核对 Vision Text Blocks / OCR / bbox 覆盖，确保没有把标题、按钮文案、标签、名称、数值、状态等普通或动态文本带进图片；若带入，拆成无文本视觉资产 + DOM 文本
- 禁止从宿主或校验流程生成的 PNG 上裁剪资产，包括 \`module-render.png\`、\`module-text-source.png\`、\`svg.png\`、\`html.png\`、\`diff.png\`、整页渲染图、模块渲染图和 OCR/verify 截图；这些图片只可用于观察和校验，不可作为资产来源
- 不要自己拼 Chrome/PIL/截图/像素 diff 脚本；局部自检必须使用官方 \`verify-module-design\`
- 不要对未合并模块直接跑整页 \`verify-design\`；整页 full verify 只由宿主 pipeline 在模块收敛后执行
- 每次运行局部校验前，先尽可能把当前能判断的结构、尺寸、层级、字体、间距、图片槽、重复模板问题集中改完；不要改一个 left/top/font-size/颜色就校验一次
- 单个模块 turn 内最多运行 2 次局部校验；第 1 次用于确认整批修改方向，第 2 次只验证最后一批高影响修复。若仍未达标，保留确认改善并结束，让下一轮反馈继续
- 局部校验通过或 diff 已明显收敛后，不要继续微调小像素
- 如果一批修改后收益很小或开始反复波动，停止继续微调，保留已确认有收益的改动并结束本轮
- 不要用 \`cat\`、\`sed\`、\`head\`、\`tail\` 直接输出整个 \`module.svg\`；很多 SVG 是单行压缩文件，直接读会把数 MB path 数据灌进上下文。优先读模块摘要和 OCR/asset 清单，需要 SVG 结构时用官方 inspect 命令做有界输出

## 模块信息
- id: ${module.id}
- kind: ${module.kind}
- region: x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}（全局坐标）
- 模块 SVG（裁切后，局部坐标系）: ${moduleSvgPath}
${sharedLayerSection}

## 坐标系说明
**重要**：你看到的模块 SVG 已经裁切到本模块区域，使用**局部坐标系**（从 0,0 开始）。
- 当前 session 使用 \`${scaleLabel}x\` SVG 渲染缩放；源 SVG 坐标换算为最终 CSS/验证像素时先乘以 ${scaleLabel}，再按 \`1rem=100px\` 转 rem
- 模块 SVG 的渲染尺寸对应本模块 ${region.width}x${region.height}；raw viewBox 可能沿用源 SVG 坐标单位，不要直接把 raw path 数值当成 CSS 像素
- 你输出的 fragment.html/css 中的 left/top 应该使用**渲染后的局部像素坐标**（从 0 开始），优先参考 Vision Text Blocks / text-layout 中的 bbox；OCR 只作粗定位参考
- 合并时会自动把你的 fragment 偏移到全局位置 (${region.x}, ${region.y})

## 输入资源
- Module Input Summary（优先读，已包含 SVG 有界摘要、OCR、资产表）: ${moduleInputSummaryPath}
- Module Input Summary JSON: ${moduleInputSummaryJsonPath}
- Vision Text Blocks（视觉模型确认的文本真值，优先于 OCR；textRegion 为真实文字框）: ${path.join(workingDir, "module-text-blocks.json")}
- Text Style Hints（宿主根据模块截图和文本框预推断的 font-size/font-weight/line-height，优先作为普通 DOM 文本默认字体依据）: ${moduleTextStyleHintsPath}
- Module OCR Blocks（宿主按本模块区域裁出，bbox 为局部坐标）: ${path.join(workingDir, "module-ocr-blocks.json")}
- Allowed Assets（宿主允许本模块引用的外部静态资产；通常为空，只读，不要修改）: ${path.join(workingDir, "allowed-assets.json")}
- 模块 SVG（只作渲染/必要细节参考，不要整文件 dump）: ${moduleSvgPath}
- 官方 SVG inspect 命令（有界输出，替代直接 dump SVG）:
  \`pnpm --dir ${process.cwd()} exec tsx ${moduleInspectCliPath} --module-dir ${workingDir} --module-svg ${moduleSvgPath} --format text --max-elements 120\`
- 需要只看某类节点时给 inspect 加 \`--tag image\` / \`--tag rect,path\` / \`--from-index 120\`，仍保持有界输出
- 官方 SVG 节点透明导出命令（使用 inspect 输出的 \`#index\`，或用 \`--selector\` 指定节点；输出必须放到本模块 \`assets/\`）:
  \`pnpm --dir ${process.cwd()} exec tsx ${moduleExportCliPath} --module-dir ${workingDir} --module-svg ${moduleSvgPath} --index <inspect-index> --output assets/<name>.png --padding 2 --scale ${scaleLabel}\`
- 对照页（只读）: ${design.compareHtmlPath}
- 官方局部校验命令（在本模块目录执行）:
  \`pnpm --dir ${process.cwd()} exec tsx ${moduleVerifyCliPath} --module-dir ${workingDir} --module-id ${module.id} --round 1 --scale ${scaleLabel}\`
  第二次局部校验把 \`--round 1\` 改为 \`--round 2\`。

## 输出目录
${workingDir}

必须产出以下文件：
- ${fragmentHtmlPath}（本模块的 HTML 片段，不含 html/head/body）
- ${path.join(workingDir, "fragment.css")}（本模块的样式）
- ${path.join(workingDir, "text-layout.json")}（文本布局，格式：{"rules":[],"blocks":[]}，blocks 使用局部坐标）
- ${path.join(workingDir, "manifest.json")}（至少包含 {"moduleId":"${module.id}","status":"completed"}；若声明 generatedAssets，每个资产必须放在本模块目录的 assets/ 下，并带 path/box/assetRole/textTreatment）

## 实现要求
- fragment.html 只包含本模块内部 markup，不含页面级容器
- fragment.css 使用 .${module.id} 或 [data-module-id="${module.id}"] 作用域
- text-layout.json 的 blocks 使用**局部坐标**（相对模块 region 的 0,0）
- 普通 DOM 文本的 font-size、font-weight、line-height 优先采用 Text Style Hints 中同 id 文本块的 declarations；如果视觉校验证明需要偏离，才做局部调整，并同步写入 text-layout.json 对应 block 的 declarations
- text-layout.json 的每个可见普通文本 block 应包含 selectors、region、declarations；declarations 至少写入 font-size/font-weight/line-height；不要写 fontSize/fontWeight/lineHeight 顶层字段
- 只能引用 allowed-assets.json 中列出的宿主静态资产，或自己生成到本模块 assets/ 目录并登记在 manifest.generatedAssets 的模块局部资产
- 引用 allowed-assets.json 里的宿主静态资产时，优先使用其中的 htmlRef/relativePath；不要手写 /Users/... 绝对路径
- 普通 UI 文案必须用 DOM 重建；不要把整页、整模块、整列表或大裁片当作带文字图片 fallback
- icon、渐变、复杂装饰和视觉字形必须按 SVG 节点导出 PNG 后引用；纯色矩形、边框和普通布局容器可以用 CSS，但不能用 CSS 近似重绘 SVG 视觉节点
- 自生成 SVG 节点 PNG 必须由官方 \`export-svg-node-asset\` 从 \`module.svg\` 透明导出，并追加当前 session 的显式倍率 \`--scale ${scaleLabel}\`；不要从任何已生成 PNG 截图或渲染图上 crop 资产
- 自生成 PNG 资产必须放在本模块 \`assets/\` 目录，并登记到 manifest.generatedAssets；每项至少包含 path、box、assetRole、textTreatment
- 优先按语义结构组织：section 内部再拆 header/nav/list/card/item/text-area 等
- 推荐节奏：先阅读 module-input-summary.md、module-text-blocks.json、allowed-assets.json 和现有 fragment；OCR 仅用于粗定位/debug，普通 DOM 文案以 Vision Text Blocks 为准。只有摘要不足时才运行 inspect 命令查 SVG 细节。一次性完成主要结构/样式修复；再运行一次局部校验；根据 diff png/report 再做最后一批高影响修复，必要时运行第二次局部校验后结束

完成后简短说明产物是否已写齐。
`.trim();
}

/**
 * 构造 feedback prompt
 *
 * TODO: 在完整 feedback 循环实现后使用
 */
function buildAgentUnitFeedbackPrompt(input: {
  module: SvgVerticalModule;
  feedbackRound: number;
  diffRatio: number;
  localVerifyArtifacts?: {
    diffPngPath?: string;
    htmlPngPath?: string;
    previewHtmlPath?: string;
    svgPngPath?: string;
    verifyReportPath?: string;
  };
  mergeError?: string;
  threshold: number;
}): string {
  const {
    feedbackRound,
    diffRatio,
    localVerifyArtifacts,
    mergeError,
    threshold,
  } = input;
  const mergeDiagnostics = mergeError
    ? `

## 合并/策略诊断
上一轮该模块没有成功进入最终 HTML，原因如下：

\`\`\`text
${mergeError}
\`\`\`

请优先修复这个硬错误，再处理视觉差异。若错误涉及 generatedAssets must live under assets/，必须把自生成资源放到本模块 assets/ 目录，并同步改 fragment 引用与 manifest.generatedAssets.path。若错误涉及 allowed-assets.json，必须改用其中列出的宿主静态资产 htmlRef/relativePath；不要把宿主提供的静态资产写进 manifest.generatedAssets。`
    : "";
  const localVerifyDiagnostics = localVerifyArtifacts
    ? `

## 局部 verify 产物
- verify report: ${localVerifyArtifacts.verifyReportPath ?? "n/a"}
- diff png: ${localVerifyArtifacts.diffPngPath ?? "n/a"}
- rendered html png: ${localVerifyArtifacts.htmlPngPath ?? "n/a"}
- rendered svg png: ${localVerifyArtifacts.svgPngPath ?? "n/a"}
- preview html: ${localVerifyArtifacts.previewHtmlPath ?? "n/a"}`
    : "";
  return `
## 模块验收反馈（第 ${feedbackRound} 轮）
- 当前模块 region diffRatio: ${(diffRatio * 100).toFixed(2)}%
- 目标阈值: ${(threshold * 100).toFixed(2)}%
${mergeDiagnostics}
${localVerifyDiagnostics}

请优先降低本模块局部 diff。先阅读局部 verify 产物、模块 SVG、OCR blocks、allowed-assets 清单和当前 fragment，把主要容器错位、重复卡片模板、共享字体/字重/行高、图片槽尺寸、层级遮挡等高影响问题合并成一批修改；如果局部 target 里的透明区域透出了共享底图，不要用黑色/白色/不透明根背景去填整块透明区域，只还原本模块自己拥有且有明确边界的背景节点；不要围绕单个 left/top/font-size/颜色反复截图试参，也不要自己拼 Chrome/PIL/像素 diff 脚本。本 turn 内最多再跑 2 次官方局部校验，每次校验前都要先尽可能完成一整批可判断修复；整页 full verify 由宿主 pipeline 统一执行。若本轮只剩文字渲染或小像素波动，保留已确认改善并结束。
`.trim();
}

// 导出以供后续使用
export { buildAgentUnitFeedbackPrompt, createAgentUnitThread };
