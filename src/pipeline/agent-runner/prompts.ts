import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "../../../prompts");

const PROMPT_FILES = ["svg-design-to-html-llm-assisted.md"] as const;

const rawPromptContents = PROMPT_FILES.map((fileName) => {
  try {
    return readFileSync(path.join(PROMPTS_DIR, fileName), "utf8").trim();
  } catch {
    return "";
  }
}).filter(Boolean);

const readOptionalFile = (filePath: string) => {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
};

const readOptionalJson = <T>(filePath: string): T | null => {
  const raw = readOptionalFile(filePath);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const formatNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : "unknown";

const formatDuration = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value / 1000).toFixed(1)}s`
    : "unknown";

const formatPercent = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(2)}%`
    : "unknown";

const formatScale = (scale: unknown) =>
  typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;

const buildDesignScaleRules = (scaleInput: unknown) => {
  const scale = formatScale(scaleInput);
  const scaleLabel = Number.isInteger(scale) ? `${scale}` : scale.toFixed(3);
  return [
    "`1rem = 100px`。",
    `当前 session 的 SVG 渲染缩放由上传/CLI 配置决定：\`scale=${scaleLabel}x\`。`,
    `所有 SVG 源坐标换算到最终 CSS/验证像素时先乘以 \`${scaleLabel}\`，再除以 100 转 rem：\`rem = SVG源坐标 * ${scaleLabel} / 100\`。`,
    `如果你手动运行 generate/verify/module verify 等 CLI，必须追加 \`--scale ${scaleLabel}\`，与当前 session 配置保持一致。`,
    scale === 2
      ? "本 session 是 2x 流程：例如 SVG 里 375px 宽对应最终视觉 750px，375px -> 7.500rem。"
      : scale === 1
        ? "本 session 是 1x 流程：SVG 源坐标就是最终视觉像素，750px -> 7.500rem。"
        : `本 session 使用自定义 ${scaleLabel}x 流程，不能套用固定 1x/2x 假设。`,
  ]
    .map((line) => `- ${line}`)
    .join("\n");
};

type ModuleAgentManifestSummary = {
  concurrency?: number;
  moduleCount?: number;
  runs?: Array<{
    allowedAssetCount?: number;
    durationMs?: number;
    id?: string;
    inputTokens?: number;
    outputTokens?: number;
    status?: string;
    validation?: {
      bestDiffRatio?: number;
      finalDiffRatio?: number;
      passed?: boolean;
      status?: string;
    };
    agentAttempts?: unknown[];
  }>;
  validation?: {
    maxIterations?: number;
    rounds?: unknown[];
  };
};

type ModuleMergeManifestSummary = {
  moduleCount?: number;
  moduleIds?: string[];
  outputHtmlPath?: string;
  scaffoldHtmlPath?: string;
  textLayoutBlockCount?: number;
  textLayoutRuleCount?: number;
};

const summarizeModuleAgentManifest = (manifestPath: string) => {
  const manifest = readOptionalJson<ModuleAgentManifestSummary>(manifestPath);
  if (!manifest) return "";

  const runs = manifest.runs ?? [];
  const totalInputTokens = runs.reduce(
    (sum, run) => sum + (run.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = runs.reduce(
    (sum, run) => sum + (run.outputTokens ?? 0),
    0,
  );
  const failedRuns = runs.filter((run) => run.validation?.passed === false);

  return [
    `- moduleCount: ${formatNumber(manifest.moduleCount ?? runs.length)}`,
    `- concurrency: ${formatNumber(manifest.concurrency)}`,
    `- validation maxIterations: ${formatNumber(manifest.validation?.maxIterations)}, rounds: ${formatNumber(manifest.validation?.rounds?.length)}`,
    `- total tokens: input=${formatNumber(totalInputTokens)}, output=${formatNumber(totalOutputTokens)}`,
    failedRuns.length
      ? `- modules needing main-agent attention: ${failedRuns.map((run) => run.id ?? "unknown").join(", ")}`
      : "- modules needing main-agent attention: none",
    "",
    "Modules:",
    ...runs.map((run) => {
      const validation = run.validation;
      const attempts = Array.isArray(run.agentAttempts)
        ? run.agentAttempts.length
        : "unknown";
      return `- ${run.id ?? "unknown"}: status=${run.status ?? "unknown"}, validation=${validation?.status ?? "unknown"}, attempts=${attempts}, assets=${formatNumber(run.allowedAssetCount)}, finalDiff=${formatPercent(validation?.finalDiffRatio)}, bestDiff=${formatPercent(validation?.bestDiffRatio)}, duration=${formatDuration(run.durationMs)}, tokens=${formatNumber(run.inputTokens)}/${formatNumber(run.outputTokens)}`;
    }),
  ].join("\n");
};

const summarizeModuleMergeManifest = (manifestPath: string) => {
  const manifest = readOptionalJson<ModuleMergeManifestSummary>(manifestPath);
  if (!manifest) return "";

  return [
    `- moduleCount: ${formatNumber(manifest.moduleCount)}`,
    `- moduleIds: ${manifest.moduleIds?.join(", ") || "unknown"}`,
    `- text layout blocks/rules: ${formatNumber(manifest.textLayoutBlockCount)}/${formatNumber(manifest.textLayoutRuleCount)}`,
    `- output HTML: \`${manifest.outputHtmlPath ?? "unknown"}\``,
    `- scaffold HTML: \`${manifest.scaffoldHtmlPath ?? "unknown"}\``,
  ].join("\n");
};

const loadSystemRules = (vars: {
  svgPath: string;
  htmlPath: string;
  compareHtmlPath: string;
  scale?: number;
}) => {
  const dir = path.dirname(vars.svgPath);
  const designName = path.basename(vars.svgPath, ".svg");

  return rawPromptContents
    .map((content) =>
      content
        .replaceAll("sessions/当前会话目录/设计稿.svg", vars.svgPath)
        .replaceAll("sessions/当前会话目录/还原页.html", vars.htmlPath)
        .replaceAll(
          "sessions/当前会话目录/对照页.compare.html",
          vars.compareHtmlPath,
        )
        .replaceAll("设计稿.svg路径", vars.svgPath)
        .replaceAll("还原页.html", `${designName}.html`)
        .replaceAll("对照页.compare.html", `${designName}.compare.html`)
        .replaceAll("设计稿.svg", `${designName}.svg`)
        .replaceAll(
          "- 当前 session 的具体换算规则会由宿主运行时注入到这里。",
          buildDesignScaleRules(vars.scale),
        )
        .replaceAll(
          "\n- 如果你是在仓库里直接阅读本提示词文件，而不是读取宿主注入后的完整 agent prompt：实际换算规则以当前 session 的 `SVG 渲染缩放`/`scale` 配置为准；不要套用固定 1x 或 2x 假设。",
          "",
        )
        .replaceAll("workspace/sessions/当前会话目录/*.svg", `${dir}/*.svg`)
        .replaceAll("workspace/sessions/当前会话目录/*.html", `${dir}/*.html`)
        .replaceAll(
          "workspace/sessions/当前会话目录/*.compare.html",
          `${dir}/*.compare.html`,
        )
        .replaceAll("workspace/sessions/当前会话目录/", `${dir}/`),
    )
    .join("\n\n---\n\n");
};

const getInitialPrompt = ({
  artifactDir,
  compareHtmlPath,
  multiAgentRoute = false,
  htmlPath,
  svgPath,
  scale,
}: {
  artifactDir: string;
  compareHtmlPath: string;
  multiAgentRoute?: boolean;
  htmlPath: string;
  svgPath: string;
  scale?: number;
}) => {
  const systemRules = loadSystemRules({ svgPath, htmlPath, compareHtmlPath, scale });
  const containerLayoutPath = path.join(artifactDir, "container-layout.md");
  const structureDraftPath = path.join(artifactDir, "structure-draft.json");
  const modulePlanPath = path.join(artifactDir, "modules", "module-plan.md");
  const modulePlanQualityPath = path.join(
    artifactDir,
    "modules",
    "module-plan-quality.md",
  );
  const moduleAgentManifestPath = path.join(
    artifactDir,
    "modules",
    "module-agent-manifest.json",
  );
  const moduleMergeManifestPath = path.join(
    artifactDir,
    "modules",
    "module-merge-manifest.json",
  );
  const modulePlan = readOptionalFile(modulePlanPath);
  const modulePlanQuality = readOptionalFile(modulePlanQualityPath);
  const moduleAgentManifestSummary = summarizeModuleAgentManifest(
    moduleAgentManifestPath,
  );
  const moduleMergeManifestSummary = summarizeModuleMergeManifest(
    moduleMergeManifestPath,
  );
  const preflightSection = `

## Workflow Preflight
${multiAgentRoute ? "- 多 agent 路线已完成 module agents 与 module merge。本轮你是合并级总控 agent，只处理跨模块边界、共享样式、DOM ownership、workflow lint 与 final-output-policy；宿主流程会在你完成后自动运行 verify / deterministic text tuning，不要自行运行这些命令。" : "- 这次运行必须按固定流程工作：resolve-container-layout -> build scaffold -> plan modules -> rebuild HTML -> verify"}
- 可按需读取仓库根目录的 \`AGENTS.md\`/\`agent.md\`、\`package.json\`、\`prompts/\`、\`docs/\` 和相关 \`src/\` 文件来理解项目规范；查文件时优先用 \`rg --files\`/\`rg\` 并排除 node_modules。
- HTML 脚手架已经初始化完成：\`${htmlPath}\`
- 如需完整父子结构，继续查看：\`${containerLayoutPath}\` 里的 Root Children / Repeated Groups / Container Tree
- 初始 DOM 骨架参考：\`${structureDraftPath}\`，结合 OCR bbox 与 SVG/container 边界把文本、图标、壳层归入最近的语义父容器
- 首轮搭结构时不要绕开其中的 Priority Recipes 和 Hard Rules
- 单 agent 路线也必须先建树状 DOM：页面根节点只放顶层 section/module；模块内部按 header/nav/toolbar/list/card/item/text-area 等容器组织。不要把大量 OCR 文本、图标、装饰直接平铺在 .design-page 或大 workspace/panel 下。
- 对疑似重复 item：允许采用 HTML 数据数组 + 模板函数/循环渲染的思路，先实现一个 item 模板，再用数据数组生成多个 item；如不写运行时 JS，也可静态展开，但结构上仍保持统一 item 模板。重复 item 内如果包含图片槽，可把图片作为该 item 数据字段处理；图片上方独立叠加的控件、标签、遮罩、标题等子层仍要单独做 DOM/CSS。不要把粗略重复结构线索当成裁剪区域或像素级 diff 区域。
- 文本节点和承载文本的容器禁止使用 CSS/SVG transform（尤其是 scale、scaleX、scaleY、matrix、skew）来拉伸、压扁或校准文字；文字尺寸只能通过 font-size、font-weight、line-height、letter-spacing、width/height/position 等正常排版属性调整，避免字形变形。
- 禁止用 CSS/HTML/伪元素/border/box-shadow/clip-path 手画 icon、渐变、滤镜、复杂装饰、logo 或艺术字；这类视觉元素必须根据位置、bbox、层级和 paint order 回到 SVG 定位对应节点，导出模块局部 PNG，再按原层级贴回。
- 从 SVG 节点生成模块局部 PNG 时，使用官方 \`src/cli/export-svg-node-asset.ts\` 从当前模块 \`module.svg\` 的指定节点透明导出；不要临时手写 Chrome/PIL/截图裁剪脚本。
- 单个 SVG 节点是默认允许的资产边界，包括承载子路径的共同父 \`g\` / \`use\`；如果该节点只是普通文本/标签/数值且没有装饰、logo、艺术字形或图形效果绑定，必须改成 DOM 文本。多个没有共同父级的 SVG sibling 节点一般不能合成一个资产，除非它们共同构成不可拆的艺术字、品牌字形或强装饰视觉文字，并在 manifest 中声明视觉文字用途和 textTreatment。
- OCR 中 1~2 个字符、符号、乱码或和图标/控件重叠的短 token 只作线索：先核对 SVG 节点、容器语义和截图。确认是图标/装饰/控件时，从 SVG 中定位对应单个视觉节点并导出 PNG 资产，不要把它误写成普通 tracked 文本；确认是业务文案/数字时再按真实文本处理。
- 使用任何 PNG 视觉资产前，必须核对 OCR / Vision Text Blocks / bbox 覆盖关系，确认没有把标题、按钮文案、标签、名称、数值、状态等普通或动态文本带进图片；若带入，拆成无文本视觉资产 + DOM 文本。
- 禁止从宿主或校验流程生成的 PNG 上裁剪资产，包括 \`module-render.png\`、\`module-text-source.png\`、\`svg.png\`、\`html.png\`、\`diff.png\`、整页渲染图、模块渲染图和 OCR/verify 截图；这些图片只可用于观察和校验，不可作为资产来源。
- 如果 text-box 或 text-insights 显示大量同类文本整体更窄、更矮、下移或字号偏小，优先按重复模板、容器层级或共享文本类批量调 font-size/font-weight/line-height/letter-spacing 和文本盒位置，不要逐个 token 手调，也不要用 transform 缩放文字。
- 遇到 Container Layout 的 repeat-group 时，必须做成统一 list/row/grid 父容器加多个 article/item；同类 item 内部尽量保持一致子结构，位置用相对父容器的 bbox 偏移表达。
- 验证策略：微调阶段只使用 fast verify 做低成本像素/module diff 自检；full verify 会触发 OCR/text-box/layout-box/workflow lint，主要用于关键诊断和最终验收。
- 验证节奏：单个 agent turn 内最多运行 4 次 \`verify-design\`。不要在每个小改后运行验证；每次验证前先根据已有报告、截图、SVG/HTML 源码，把同一区域、同一层级或同一类问题合并成一批修改，尽可能一次修复更多高优先级问题，再用 fast verify 检查整体方向；不要为了单个 left/top/font-size、单句文案、单个色值或单个边距反复验证。
- 如果 batch 后 diff 只剩很小改善、没有改善或开始反复波动，应停止逐像素试参，保留已确认有收益的修改并在回复里说明剩余问题；宿主流程会在本 turn 后继续执行 fast/full verify。
- 即使总 diffRatio 已接近目标，diff-insights 的局部 cluster、grid hotspot、hairline hotspot 仍然要作为局部错位信号处理；优先修对应容器、图片槽、边线、图标和文本层级。

${modulePlan ? `## Module Plan\n- 模块规划路径：\`${modulePlanPath}\`\n- 模块质量报告：\`${modulePlanQualityPath}\`\n- 模块 agent manifest：\`${moduleAgentManifestPath}\`\n- 模块 merge manifest：\`${moduleMergeManifestPath}\`\n- 若这些 manifest 已存在，说明 HTML 已由多个模块 agent 片段合并完成；本轮你是总控 agent，请优先做跨模块边界、共享样式、全页一致性修边，不要从零重写。\n\n${modulePlan}` : ""}

${modulePlanQuality ? `### Module Plan Quality\n${modulePlanQuality}` : ""}

${moduleAgentManifestSummary ? `### Module Agent Manifest Summary\n${moduleAgentManifestSummary}` : ""}

${moduleMergeManifestSummary ? `### Module Merge Manifest Summary\n${moduleMergeManifestSummary}` : ""}
`.trim();

  return `
${systemRules}

---

你现在在这个仓库里作为一个可继续对话的大模型代理工作。

## 当前目标
- 依据 SVG：\`${svgPath}\`
- 产出 HTML：\`${htmlPath}\`
- 产出对照页：\`${compareHtmlPath}\`
- SVG 渲染缩放：\`${formatScale(scale)}x\`

${preflightSection}

${multiAgentRoute ? "请以本轮多 agent 路线职责边界为准：不要重写局部模块，不要追逐单模块小像素差异，不要自行运行 verify/tuning 命令。你的输出应简洁说明你完成的合并级修复。" : "请严格按照上述系统规则中的工作流、硬规则和验证闭环要求执行。你的输出应像正常助手对话一样，简洁说明你做了什么、当前状态以及下一步建议。"}
`.trim();
};

export {
  getInitialPrompt,
};
