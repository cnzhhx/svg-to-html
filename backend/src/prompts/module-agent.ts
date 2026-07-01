import path from "node:path";
import { existsSync } from "node:fs";

import type { ResolvedDesignTarget } from "../core/design-resolve.js";
import type { SvgVerticalModule } from "../core/svg-vertical-modules/types.js";
import {
  getSourceFragmentFileName,
  normalizeOutputFormat,
  type OutputFormat,
} from "../core/output-target.js";
import type { ModulePlan } from "../pipeline/module-merge/types.js";
import {
  buildModuleCoordinatorPromptSection,
  type ModuleAgentCoordinatorDecision,
} from "../pipeline/agent-runner/module/module-agent-coordinator.js";

const resolveModuleOutputFormat = ({
  design,
  modulePlan,
}: {
  design: ResolvedDesignTarget;
  modulePlan: ModulePlan;
}) =>
  normalizeOutputFormat(
    (modulePlan as { outputFormat?: unknown }).outputFormat ??
      (
        design as {
          outputFormat?: unknown;
          outputTarget?: { format?: unknown };
        }
      ).outputFormat ??
      (design as { outputTarget?: { format?: unknown } }).outputTarget?.format,
  );

const buildModuleInputPathList = ({
  round,
  workingDir,
  semanticPreloaded = false,
}: {
  round?: number;
  semanticPreloaded?: boolean;
  workingDir: string;
}) => {
  const paths: Array<[string, string]> = [
    ["模块工作目录", workingDir],
    [
      semanticPreloaded
        ? "结构化主输入 JSON（已在本 prompt 末尾预加载精简版；导出资产后再按需读取刷新）"
        : "结构化主输入 JSON（必须自行读取）",
      path.join(workingDir, "module-semantic.json"),
    ],
    [
      "模块参考图（按需自行打开/读取）",
      path.join(workingDir, "module-reference.png"),
    ],
  ];
  const sharedUnderlayPath = path.join(workingDir, "shared-underlay.png");
  if (existsSync(sharedUnderlayPath)) {
    paths.push([
      "共享背景层参考图（按需读取，不要重复实现）",
      sharedUnderlayPath,
    ]);
  }
  const compositePath = path.join(workingDir, "composite.png");
  if (existsSync(compositePath)) {
    paths.push(["最终叠加效果参考图（按需读取）", compositePath]);
  }
  const assetsPath = path.join(workingDir, "assets");
  if (existsSync(assetsPath)) {
    paths.push([
      "已导出资产目录（资产清单以 module-semantic.json 为准，目录用 ls 查看）",
      assetsPath,
    ]);
  }

  if (round && round > 1) {
    const verifyDir = path.join(workingDir, "verify", `round-${round - 1}`);
    paths.push(
      [
        "上一轮 HTML 渲染图（存在时按需读取）",
        path.join(verifyDir, "render.png"),
      ],
      [
        "上一轮 SVG 参考图（存在时按需读取）",
        path.join(verifyDir, "svg.png"),
      ],
    );
  }

  return paths.map(([label, filePath]) => `- ${label}: ${filePath}`).join("\n");
};

const buildOptionalReferenceUsageLines = (workingDir: string) => {
  const lines = [
    "- module-reference.png：模块独立渲染参考图，背景透明，按需自行读取",
  ];
  if (existsSync(path.join(workingDir, "shared-underlay.png"))) {
    lines.push(
      "- shared-underlay.png：宿主在模块背后渲染的共享背景层，按需读取，不要重复实现它",
    );
  }
  if (existsSync(path.join(workingDir, "composite.png"))) {
    lines.push(
      "- composite.png：模块内容 + 共享背景叠加后的最终效果，按需读取",
    );
  }
  return lines.join("\n");
};

function buildAgentUnitFollowupBasePrompt(input: {
  module: SvgVerticalModule;
  design: ResolvedDesignTarget;
  modulePlan: ModulePlan;
  workingDir: string;
  round: number;
}): string {
  const {
    module,
    design,
    modulePlan,
    workingDir,
    round,
  } = input;
  const outputFormat = resolveModuleOutputFormat({ design, modulePlan });
  const isFrameworkOutput = outputFormat === "vue" || outputFormat === "react";
  const moduleSemanticJsonPath = path.join(workingDir, "module-semantic.json");
  const moduleAlignmentDiagnosticsCliPath = path.join(
    process.cwd(),
    "src/cli/diagnose-module-alignment.ts",
  );
  const moduleReasonLine =
    typeof module.reason === "string" && module.reason.trim().length > 0
      ? ` | ${module.reason.trim()}`
      : "";
  const sharedLayers = (modulePlan.sharedLayers ?? []).filter((layer) => {
    const layerRegion = layer.region;
    if (!layerRegion) return false;
    return (
      layerRegion.x < module.region.x + module.region.width &&
      layerRegion.x + layerRegion.width > module.region.x &&
      layerRegion.y < module.region.y + module.region.height &&
      layerRegion.y + layerRegion.height > module.region.y
    );
  });
  const sharedLayerNote = sharedLayers.length
    ? ` | 共享层: ${sharedLayers.map((l) => l.id).join(",")}`
    : "";
  const inputPathList = buildModuleInputPathList({ round, workingDir });

  return `
## 第 ${round} 轮模块继续修复（模块 ${module.id}）

继续遵守之前的基础约束。模块上下文不变：
- ${module.id} | ${module.kind}${moduleReasonLine} | ${module.region.width}x${module.region.height}${sharedLayerNote}
- outputFormat: ${outputFormat}
- Semantic JSON: ${moduleSemanticJsonPath}

## 坐标系重述
- 所有坐标都是**相对于模块左上角**的局部坐标，直接使用 px
- 模块根容器由宿主自动定位到左上角 (0,0)，**禁止给根容器加任何偏移**
- render.png / svg.png 只用于定位问题区域和验证结果，不能把“截图看起来大约 x=...”当成坐标来源
- 若审核诊断与结构化 bbox/text 样式冲突，优先信任结构化数据；先解释冲突来自父盒选择、mask/clip/crop、资源裁切、坐标系或文本渲染差异，再修复
- alignment diagnostics 只做图片/文本 DOM 目标匹配和 rect 偏差提示；diffRatio 是最终验收反馈。verify stdout 会返回 alignmentDiagnostics 摘要；若上一轮 diffRatio >= 0.05，优先读取该摘要和 alignment-diagnostics.json，只批量修复 positionIssues 里的缺失/重复匹配/明显位置尺寸偏差。

## 输入路径（本轮不会附加 JSON 内容或图片二进制）
${inputPathList}

必须按路径自行读取需要的文件；不要假设本 prompt 已包含 module-semantic.json 内容或任何参考图像。

## 对齐诊断
- verify 会自动运行 alignment diagnostics，并在 stdout 返回 \`alignmentDiagnostics\` 摘要。独立命令只在 verify 摘要缺失/报错或需要重测指定入口时使用：${isFrameworkOutput ? `\`pnpm --dir ${process.cwd()} exec tsx ${moduleAlignmentDiagnosticsCliPath} --module-dir ${workingDir} --module-id ${module.id} --render-entry ${path.join(workingDir, "verify", "framework-round-<N>", "entry", "dist", "index.html")} --diff-ratio <verify输出diffRatio>\`` : `\`pnpm --dir ${process.cwd()} exec tsx ${moduleAlignmentDiagnosticsCliPath} --module-dir ${workingDir} --module-id ${module.id} --verify-round <N> --diff-ratio <verify输出diffRatio>\``}
- 诊断默认写入 ${path.join(workingDir, "alignment-diagnostics.json")}；只根据 positionIssues 批量修布局。文本问题只能改外盒/父容器，禁止改字体相关属性。若文本 x/y 基本对齐、无换行/裁切/缺字，只剩 width/height 或 glyph 度量偏差，应视为字体渲染差异，不再继续迭代。
`.trim();
}

function buildAgentUnitPrompt(input: {
  module: SvgVerticalModule;
  design: ResolvedDesignTarget;
  modulePlan: ModulePlan;
  moduleCoordinator?: ModuleAgentCoordinatorDecision;
  workingDir: string;
}): string {
  const {
    module,
    design,
    modulePlan,
    moduleCoordinator,
    workingDir,
  } = input;
  const region = module.region;
  const outputFormat = resolveModuleOutputFormat({ design, modulePlan });
  const previewFragmentHtmlPath = path.join(
    workingDir,
    "preview.fragment.html",
  );
  const moduleCssPath = path.join(workingDir, "module.css");
  const sourceFragmentPath =
    outputFormat === "html"
      ? previewFragmentHtmlPath
      : path.join(workingDir, getSourceFragmentFileName(outputFormat));
  const sourceFragmentRequirement =
    outputFormat === "html"
      ? ""
      : outputFormat === "vue"
        ? "- source.fragment.vue.html：Vue template body 片段（不含 <template>/<script>/<style> 外壳、不含 import/export/函数声明）。重复/数据驱动结构用 v-for；数据写入 source-data.json，模板里通过 sourceData[\"<本模块id>\"].xxx 引用。\n  **图片路径规则**：静态图片（非 v-for 内）直接用普通 `src=\"./assets/xxx.png\"`，不要用 `:src=\"'./assets/xxx.png'\"`（字符串字面量绑定）。只有在 v-for 循环或需要动态拼接路径时才用 `:src=\"item.imgPath\"`（引用 sourceData 字段）。source-data.json 里的图片路径也统一写 `./assets/xxx.png`（相对模块目录）。"
        : "- source.fragment.jsx：React JSX 子片段（不含 import/export/函数声明）。重复/数据驱动结构用 .map；数据写入 source-data.json，模板里通过 sourceData[\"<本模块id>\"].xxx 引用。\n  **图片路径规则**：静态图片直接用 `src=\"./assets/xxx.png\"`。动态图片（.map 内）在 source-data.json 中写完整相对路径 `./assets/xxx.png`，JSX 中直接引用 `src={item.imgPath}`，**禁止**用模板字面量拼接路径前缀如 `` src={`./assets/${item.img}`} ``（merge 会重写 sourceData 路径导致双重前缀）。条件表达式中引用文件名同理：把完整路径放入 sourceData 字段，JSX 中直接用字段值。";
  const sourceDataPath = path.join(workingDir, "source-data.json");
  const isFrameworkOutput = outputFormat === "vue" || outputFormat === "react";
  const sourceDataContractSection = isFrameworkOutput
    ? `
## source-data.json 契约（${outputFormat === "vue" ? "Vue" : "React"}）
- 宿主会把整个 source-data.json **原样**作为 \`sourceData["${module.id}"]\` 注入（Vue 在 <script setup>，React 在组件函数体），最终形如 \`const sourceData = { "${module.id}": <你的JSON>, ...其它模块 };\`
- **因此 source-data.json 里不要再嵌一层模块 id 键**。直接写裸数据即可，例如 \`{ "items": [...], "title": "..." }\`，**不要**写 \`{ "${module.id}": { "items": [...] } }\`（会导致双重嵌套）。
- source fragment 引用本模块数据**必须**写 \`sourceData["${module.id}"].xxx\`，例如 \`v-for="item in sourceData['${module.id}'].items"\`（Vue）或 \`sourceData["${module.id}"].items.map(...)\`（React）。
- source-data.json 是普通 JSON 对象（任意键），不需要写 bindings 数组或任何特殊结构。
- 没有 source-data.json 的模块（纯静态布局）可以不写这个文件，宿主会注入 \`const sourceData = {};\` 兜底。
`
    : "";
  const moduleVerifyCliPath = path.join(
    process.cwd(),
    isFrameworkOutput
      ? "src/cli/verify-module-framework.ts"
      : "src/cli/verify-module-design.ts",
  );
  const moduleAlignmentDiagnosticsCliPath = path.join(
    process.cwd(),
    "src/cli/diagnose-module-alignment.ts",
  );
  const moduleSemanticJsonPath = path.join(
    workingDir,
    "module-semantic.json",
  );
  const inputPathList = buildModuleInputPathList({
    semanticPreloaded: true,
    workingDir,
  });
  const referenceUsageLines = buildOptionalReferenceUsageLines(workingDir);
  const scale =
    typeof design.scale === "number" &&
    Number.isFinite(design.scale) &&
    design.scale > 0
      ? design.scale
      : 1;
  const scaleLabel = Number.isInteger(scale) ? `${scale}` : scale.toFixed(3);
  const moduleReasonLine =
    typeof module.reason === "string" && module.reason.trim().length > 0
      ? `- planner reason: ${module.reason.trim()}`
      : "";
  const semanticJsonUsageLine = "- module-semantic.json：结构化主输入，已在末尾预加载（精简版）。导出资产后如需刷新 generatedAssets，再次 read 磁盘文件";
  const methodFirstStep = "1. 直接使用末尾预加载的 module-semantic.json 精简版（无需再 read）；只按需读取输入路径列表里实际提供的参考图，确认语义层级、关键视觉块、关键文本框和区域类型。generatedAssets 初始可能为空，不代表缺资源；首批视觉还原优先把 textBlocks 之外的复杂视觉节点/组合节点通过 browser-session_export_svg_node tool 导出 PNG，不要先花大量时间用 CSS 手绘或逐节点推理。需要图片资源时，从 nodes 的 nodeId/inspectIndex/bbox/semantic 判断并导出。不要把所有节点坐标逐项重算成超长“几何账本”。结构化坐标（已导出图片资产用 generatedAssets[].box，其余按需参考 nodes[].bbox）是坐标主来源，截图只用于理解语义和验证。";
  const moduleCoordinatorSection = moduleCoordinator
    ? buildModuleCoordinatorPromptSection(moduleCoordinator)
    : "";
  const dualFragmentSection = isFrameworkOutput
    ? `
## 双片段对齐（${outputFormat === "vue" ? "Vue" : "React"}）
本模块要同时产出两份视觉等价的产物，二者**必须保持同一画面**（同样的元素、文本、资产、坐标、层级），只是写法不同：
- **preview.fragment.html**：纯 HTML，把重复结构展开写（如 9 个 cell 全部手写），用于像素级 verify 调优。
- **source.fragment.${outputFormat === "vue" ? "vue.html" : "jsx"}**：用框架惯用法（v-for / .map + sourceData 绑定）表达同样的语义结构。
- 写完 source fragment 后**必须**确认：所有在 preview 里出现的可见文本/图片/元素，在 source fragment 里都有对应；sourceData 里能查到引用的数据；不要在 source fragment 里引用 preview 没有的元素，也不要漏掉 preview 里的元素。
`
    : "";
  return `
你是设计稿还原专家，精通将设计稿（SVG）精确还原为 HTML/CSS。目标：视觉忠实还原设计意图，结构语义清晰、布局稳定。

## 模块信息
- id: ${module.id} | kind: ${module.kind}
${moduleReasonLine}
- size: ${region.width}x${region.height} | scale: ${scaleLabel}
${dualFragmentSection}
## 输入与数据契约
module-semantic.json（精简版）和当前输出文件内容已在 prompt 末尾预加载，**首次无需再 read 这些文件**。参考图片仍需按路径自行读取：
${inputPathList}

路径用途：
${semanticJsonUsageLine}
${referenceUsageLines}
- verify stdout 的 artifacts.renderPngPath / artifacts.svgPngPath：运行 verify 后产生；需要读图时只读 stdout 返回的明确路径，不要猜 round 目录
- preview.fragment.html / module.css / manifest.json：启动前可能已存在最小可运行模板；这是方便你直接修改的脚手架，不代表已完成。直接在模板上替换/扩展即可，不要为基础 manifest/root 容器结构反复推理。

${moduleCoordinatorSection ? `${moduleCoordinatorSection}\n` : ""}

module-semantic.json 关键字段（按此优先级取用）：
| 字段 | 含义与用途 |
| --- | --- |
| module.region / scale | 模块尺寸与缩放；所有坐标都相对模块左上角，单位 px |
| textBlocks[].layoutTargetRegion | 文本的 DOM 容器框，定位文本外盒用它 |
| textBlocks[].styleInference | 文本样式（font-size/weight/color/line-height/letter-spacing/font-family），硬约束 |
| generatedAssets[] | agent 已经按需导出的资产；模块启动时可以为空，不代表缺资源 |
| generatedAssets[].box | 已导出 PNG 的 CSS 放置外框（x/y/宽/高，对应截图 clip，可能包含小数坐标取整留下的透明边）；**引用该资产时用它定位 + 定尺寸**，宽高比即 PNG 比例。资产只给路径，不会自动作为图片附件塞入请求 |
| generatedAssets[].sourceNodeIds | 该资产由哪些 SVG 节点导出，便于合并/重导 |
| nodes[].id / nodeId | SVG 节点 id；按需导出 PNG 时传给 browser-session_export_svg_node 的 nodeIds |
| nodes[].bbox | 节点几何框；用于判断位置、尺寸、分组和按需导出范围 |
| nodes[].inspectIndex | 绘制顺序，越大越靠上，是 z-index 的依据 |
| nodes[].semantic | 节点语义与导出决策 |
| nodes[].attrs.mask / filter / clip-path | 视觉引用提示；节点或其子图被裁切、加阴影或滤镜时优先导出带该属性的节点，不要只导内部 leaf 节点 |
| nodes[].visualEffects | 由 SVG filter 解析出的轻量视觉提示；可能包含 inner-shadow 的边缘方向、偏移、透明度和 CSS 近似写法，适合辅助判断简单边缘阴影/分隔线 |

- 诊断性数据（textContentBlocks / svgTextNodes / visualTextElements / textGeometryDisagreements）不在本文件里，已分流到同目录的 module-semantic.debug.json，仅供人工排查；agent 不需要也不允许读取。
- **禁止读取 module.svg、analysis-sheets/*.png、module-semantic.debug.json**。

## 硬约束（凌驾于一切视觉判断；与截图冲突时以结构化数据为准）
1. **文本来源唯一性**：只有 \`module-semantic.json\` 的 \`textBlocks\` 中列出的文案才需要还原为真实 DOM 文本。\`textBlocks\` 未覆盖的内容，agent 不得自行从截图、参考图或已导出资产中识别为 DOM 文本，应以预处理结果为准。禁止把 \`textBlocks\` 对应的预处理 DOM 文本节点导出/烤进图片；禁止用 transform/scale/matrix/skew 校准文字几何。
2. **文本归属以预处理为终审，禁止回看参考图二次确认**：某个文字是否进 textBlocks、某个节点是否含可读文本，预处理已经做了最终判定，截图/参考图上"看起来像字"或"看起来像装饰"都不构成推翻理由。节点 \`semantic.textHandling === "ignore"\`、\`semantic.textHandling === "export-asset"\` 或 \`semantic.exportDecision === "export"\` 的内容，一律按资产/装饰处理，**不得**为了"确认它到底是不是字"去读取或反复对照 module-reference.png / composite.png / shared-underlay.png。允许导出的图片资产里包含 \`textBlocks\` 未覆盖的装饰字、徽章字、截图内文字或图片自身文字；不要为了清掉这些非预处理文本而拆图、找隐藏图片节点或反复重导。textBlocks 未覆盖的内容按约束 1 处理，不要纠结其归属、不要反复推理。
3. 禁止引用/内联/裁剪原始完整 SVG，禁止 data:image/* 或 base64，禁止写原始 inline <svg>；禁止把整张卡片/整个导航/整块区域拍成一张大图替代应有结构。
4. textBlocks[].styleInference 的文本样式是预处理像素级算好的硬约束，一经使用永不修改（即便 verify diff 有偏差，也只能靠改位置/父容器解决，不许动 font-size/weight/color/line-height/letter-spacing/font-family）。仅当某样式缺失时才按视觉推断；推断颜色须取文字本身颜色，不得从邻近背景/装饰借色。
5. **字体渲染差异是不可避免且必须接受的**：原始 SVG 使用文字路径（path data）渲染，而 HTML 使用系统字体（Noto Sans CJK SC 等），两者在抗锯齿、字重、hinting、glyph 宽高/度量上必然存在差异。禁止为了降低 diff 修改或追加任何字体渲染相关属性，包括但不限于 font-size/weight/line-height/font-family/letter-spacing、font-smoothing、text-rendering、font-variant、text-shadow、filter、transform/scale。文本位置的微调（left/top 偏移 1-3px）可以容忍；若文本 x/y 已基本对齐、没有换行错误/裁切/缺字，只剩 width/height 偏差，应视为不可行动的字体度量差，不得继续迭代。
6. 普通 DOM 文本禁止用 \`overflow:hidden\`、固定单行高度、\`text-overflow\` 或裁切容器来掩盖溢出；尤其是说明文、段落、多行文本，必须保证所有文字可见。文本显示不完整时，优先调整文本外盒高度或父模块布局，不要把文字截掉。仅原设计明确是省略号/裁切标题时，才允许按原样使用 \`overflow:hidden\`。
7. 图片宽高比锁定：\`<img>\` 渲染宽高比必须等于资产 \`box\` 的自然比例。锁定一边、另一边按比例推导（\`height = round(width * box.height / box.width)\`）。适配异形槽位只能裁切（外层 \`overflow:hidden\` + \`object-fit:cover\` + \`object-position\`）或等比缩放（\`object-fit:contain\`），禁止拉伸压扁。
8. 不要给模块根容器加背景色或任何偏移；根容器由宿主定位到 (0,0)。模块背景由页面统一处理，只还原有明确边界的局部背景（卡片底色、按钮背景）。如果 module-reference.png 中只有白色图标/文字落在透明画布上，不得为了“承载”或“对比”自行补黑/白/粉等底色；shared-underlay.png / composite.png 只用于理解宿主上下文，不要重复实现成模块 root background。
9. 所有坐标、尺寸、间距统一用 px，禁止 %、vw、vh、em、rem；普通布局的 left/top/width/height/padding/margin/gap/border-radius 以整数 px 为默认，只有 textBlocks[].styleInference 里明确给出的小数样式、透明度、阴影/滤镜和必要的非文本 transform 才保留小数。
10. **对齐诊断标记硬要求**：每个 \`textBlocks[]\` 对应的真实 DOM 文本元素必须添加 \`data-node-id="<textBlock.id>"\`；每个 \`generatedAssets[]\` 对应的 \`<img>\` 必须添加 \`data-asset-id="<asset.id>"\`。刚导出资产后如果不确定 id，读取 export 命令 stdout 或 module-semantic.json 的 generatedAssets；不要让同一 data id 出现在多个可见元素上。
- **资产粒度边界**：按视觉层级切资产，而不是按整块区域偷懒合并。可独立定位的前景层（图标、标记、装饰文字、视觉数值、状态层、覆盖层等）应与背景/容器层分开导出并单独定位；背景/容器资产只承载底板、阴影、边框、纹理、遮罩等底层视觉。只有某个前景层与底图纹理、裁切或图片内容真正不可分割时，才允许合并到同一资产里。\`textBlocks\` 之外的可见文字不得擅自改成 DOM 文本，但也应遵守这个分层原则，必要时作为独立视觉资产处理。

## 方法（按序执行）
${methodFirstStep}
2. **产物优先，先落可运行初版再细调**：读完主输入后，只允许做一次短暂的首批资产决策；需要复杂非文本视觉时先批量/并行导出必要 PNG，然后立刻更新 preview.fragment.html + module.css + manifest.json（Vue/React 还要更新 source fragment）。这些文件若已有最小模板，直接改模板，不要先删除后重建，也不要为 manifest 基础字段停留。不要在写初版前长时间分析、逐节点手绘或反复读图。初版可以粗糙但必须完整可运行：textBlocks 一律 DOM 文本，非文本复杂视觉优先用已导出资产按 generatedAssets[].box 绝对定位，manifest 只填固定字段；后续脚本会补资产列表。有冲突时先选一个保守方案落盘，之后用 **browser-eval** 和 verify 修。
3. **判断区域类型，选布局范式**：
   - **非重复的自由叠放区**（状态栏、导航栏、主视觉海报、多层装饰叠加、无同构子项）→ **全部用 absolute positioning**。非文本视觉尽量导出为 PNG 后绝对定位；**图层若对应一个已导出资产，用该资产 generatedAssets[].box 的 x/y/width/height 定位 + 定尺寸（box 是 PNG 的 CSS 放置外框，别再用节点几何框或内部可见像素框去摆图片，否则会错位/压扁）**；尚未导出的视觉块先用 nodes[].bbox/inspectIndex 判断是否需要导出。z-index 按 inspectIndex 从小到大叠；不合并/丢弃图层、不挑某节点拉伸当整块背景；压在图形上的独立文字仍按 DOM 文本还原到对应位置。
   - **重复/连续/同构区**（列表、网格、卡片行、导航项、按钮组、标签组、数据行）→ **外层父容器用 flex 或 grid 管理宏观排列，每个同构子项（item/card/tab/row）内部用 absolute positioning 精确摆放内部元素**。禁止把同构子项拆成一堆互不关联的绝对定位叶子节点，也禁止逐个子项凭感觉微调。同构子项内部也要保持一致结构：图片/图标、标题、说明、数值、状态等用稳定 class 命名；只允许通过数据内容、选中态、少量修饰 class 表达差异。
   - **严禁在同构子项内部使用 CSS Grid 的 gap/auto-placement 来推算元素位置**。每个子项内部的图片、文本、badge 等必须有独立的 \`position: absolute; left: X; top: Y\`，不得依赖 flow 布局自动排列。
4. 文本：用 layoutTargetRegion 定位外盒，再用 styleInference 填样式。textBlocks[].text 是预处理已经合并好的最终 DOM 文案；直接放进一个 DOM 文本元素，保留原文内容，不要改写、拆分或重新识别文本。
5. CSS 落地时坐标/盒模型默认四舍五入到整数 px：图片资产 box、结构节点 bbox、文本 layoutTargetRegion 的 left/top/width/height 都按整数写；textBlocks[].styleInference 的 font-size/line-height/letter-spacing/font-family/weight/color 原样使用，不因取整规则修改。
6. **选实现手段（默认图片优先，能用 PNG 就不手绘）**：非文本视觉样式默认优先导出 PNG，模块 agent 不需要证明某个复杂视觉“不能用 CSS 实现”才导出。只有纯色背景、单层边框、简单圆角、简单横/竖条、状态圆点、分隔线这类简单到不能再简单的元素才用 CSS。渐变、纹理、阴影组合、clip-path 异形、mask、图标、多 path 组合、徽章、装饰壳、图片内容等都优先导出 PNG。一个视觉由多个节点组成时（icon 多 path、按钮背景+边框+高光）用 browser-session_export_svg_node 合并导出为一张；可读 textBlocks 禁止导出。对于 textBlocks 之外的可见前景层，优先按独立视觉层导出，不要并入大块背景/容器资产。
7. **browser-eval 是首选调试工具，verify 是最终验收工具**。三件套产物可运行后，**立即先用 browser-eval** 做局部自检，优先把内容缺失、错图、明显重叠、明显布局/裁切错误消灭在 verify 之前；在觉得自己"已经做完了"、所有关键元素位置都正确对齐之后，再运行 verify。不要把 verify 当调试工具频繁运行——每轮 verify 成本高，应该只有在 browser-eval 显示布局基本对齐后再进 verify 做最终 diff 检查。
8. 不确定真实 DOM 位置、尺寸、gap、行列数、裁切或 computed style 时，立即用 browser-eval 查询浏览器实际结果；如果你准备在脑中推算某个具体坐标/尺寸超过 3 行，必须改用 browser-eval。查询后只做局部、批量修 CSS/HTML，不要推倒重来；修改后如果觉得问题已解决，再跑 verify。browser-eval 通过 browser-session_browser_eval MCP tool 调用，把 JS 直接传入 script 参数，最后 return JSON，禁止再写 browser-eval.js 文件。
9. 骨架可运行后 → browser-eval 查关键容器/重复结构/文本/图片实际 rect 和 computed style → 批量修明显问题 → 确认"做完了" → verify → 按下方"校验与停损"规则决定是否读图对比与修复 → 再 verify：
   - group bbox 明显被 mask/clip/溢出图/横向裁切/透明区放大时，改用稳定子节点（主图框、标题、标签、图标、背景壳）反推父盒，不要直接拿被放大的 group bbox 当父盒。
   - verify 图与结构化数据冲突时，先用 browser-eval 核对真实 DOM，再解释冲突来源（坐标系/scale/crop/mask/资源裁切/父盒选错），改父容器/网格参数，不得直接采信截图估值。

## 输出目录 ${workingDir}（outputFormat: ${outputFormat}）
- ${previewFragmentHtmlPath}（HTML 片段，不含 html/head/body）
- ${moduleCssPath}（.${module.id} 或 [data-module-id] 作用域）
- ${path.join(workingDir, "manifest.json")}（只写 moduleId、kind、fragments、styles，**不写资产列表**，资产由脚本扫描 assets/ 自动生成）
${outputFormat === "html" ? "" : `- ${sourceFragmentPath}（${outputFormat === "vue" ? "template body 片段" : "JSX 子片段"}，禁止 import/export/函数定义）`}
${outputFormat === "html" ? "" : `- ${sourceDataPath}（有 v-for/map/绑定数据时必写，普通 JSON 对象字面量，详见下方契约）`}
${sourceFragmentRequirement ? `${sourceFragmentRequirement}\n` : ""}
${sourceDataContractSection}
## 命令
- verify: \`pnpm --dir ${process.cwd()} exec tsx ${moduleVerifyCliPath} --module-dir ${workingDir} --module-id ${module.id}${isFrameworkOutput ? ` --format ${outputFormat}` : ""} --scale ${scaleLabel}\`${
    isFrameworkOutput
      ? `\n  - 这是**框架级 verify**：会用真实 Vite 构建你的 source fragment + source-data + module.css，渲染并和 module SVG 做像素 diff。所以你必须保证 source fragment 能编译、source-data 引用名正确（sourceData["${module.id}"].xxx），否则页面会白屏、diff 极高。`
      : ""
  }
  - verify stdout 会返回 \`artifacts.renderPngPath\`（当前 HTML 渲染）、\`artifacts.svgPngPath\`（原 SVG 参考）和 \`artifacts.diffPngPath\`（不要读）。需要读图时只使用 stdout 返回的具体路径，**禁止自己猜 \`verify/round-*\`，禁止用 find/ls -R 搜索 verify 输出**。
- 浏览器自测（查真实 DOM rect/style/数量；用于布局定位，不替代最终 verify）:
  直接调用 browser-session_browser_eval tool，传入 moduleDir 和 script 参数。
  script 是在页面上下文执行的 JS，最后 return JSON。
  示例: browser-session_browser_eval({ moduleDir: "${workingDir}", script: "const el=document.querySelector('.selector'); const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};" })
  页面自动加载最新的 HTML/CSS，不需要手动 reload。
- 导出 SVG 节点为 PNG:
  直接调用 browser-session_export_svg_node tool，传入 moduleDir、nodeIds、output、padding。不要用 bash 手写 \`pnpm ... export-svg-node-asset.ts\` 命令。
  示例: browser-session_export_svg_node({ moduleDir: "${workingDir}", nodeIds: ["n0001"], output: "assets/icon-a.png", padding: 0 })
  - 合并多个节点：nodeIds 传多个 id，例如 ["n0001", "n0002"]；导出后直接在 HTML 引用 \`./assets/<name>.png\`
  - tool 会自动注册 generatedAssets，返回 JSON（含 \`clip\`/\`renderedBox\`/\`registeredAsset\`）；需要定位信息时优先用返回值，必要时再 read module-semantic.json 刷新。
  - 导出工具只会阻止导出 \`textBlocks\` 对应的预处理 DOM 文本节点及其父子树；除此之外，资产里包含非 \`textBlocks\` 的装饰字/徽章字/截图字/图片自身文字是允许的，不需要额外清理或重构。
  - 独立资产可以逐个调用 tool；不要为了导出资产改用 shell 并行拼命令。
  - **禁止写 python/node 脚本去 inspect module-semantic.json**（启动 pnpm/tsx 解释器开销大）。需要查 JSON 内容直接用 read 工具读文件。
- Semantic JSON: ${moduleSemanticJsonPath}
- 对齐诊断（诊断位置/尺寸，不替代最终 diff 验收）:
  - verify stdout 会自动包含 \`alignmentDiagnostics\` 摘要，并默认写入 \`${path.join(workingDir, "alignment-diagnostics.json")}\`。诊断只匹配图片/文本节点并报告 positionIssues；独立诊断命令只作为 fallback/debug 使用：${isFrameworkOutput ? `\`pnpm --dir ${process.cwd()} exec tsx ${moduleAlignmentDiagnosticsCliPath} --module-dir ${workingDir} --module-id ${module.id} --render-entry ${path.join(workingDir, "verify", "framework-round-<N>", "entry", "dist", "index.html")} --diff-ratio <verify输出diffRatio>\`` : `\`pnpm --dir ${process.cwd()} exec tsx ${moduleAlignmentDiagnosticsCliPath} --module-dir ${workingDir} --module-id ${module.id} --verify-round <N> --diff-ratio <verify输出diffRatio>\``}
  - 先看 \`positionIssues\`：图片偏差说明最终 img rect 偏了，通常检查父容器 gap/padding/margin 或 item 内部定位；文本偏差只允许改文本外盒/父容器，禁止改 font-size/font-weight/line-height/font-family/color。

## 校验与停损
- 空产物比低保真初版更严重：任何时候如果发现自己在同一冲突点上反复权衡，必须停止继续分析，保留/写出当前最佳可运行产物，再用 browser-eval 或 verify 进入修复循环。
- verify/browser-eval/browser-session_export_svg_node 都只能在三件套产物已经非空后执行；结束前必须确认 preview.fragment.html、module.css、manifest.json 已写齐且不是空文件。
- 修复优先级用可观察现象判断，不要给问题贴等级标签：先批量修内容缺失、结构层级错、错误资产、明显重叠、明显布局/裁切错误；文本 width/height 度量差、抗锯齿、字重/字体渲染、1-2px 抖动、小面积颜色差不要反复追。不要每个小改动都 verify。
- **宿主自动回滚机制**：每次 verify 后，如果 diffRatio 比当前最佳值反弹超过 0.5 个百分点，宿主会自动回滚到上一次最佳版本的文件状态，并终止本轮 agent。你不需要手动恢复文件。因此：如果一轮修改后 verify 结果变差，不要慌张，宿主已帮你回滚；你只需要在下一轮重新分析原因、换一种修复策略即可。
- **browser-eval 阶段无自动回滚**：browser-eval 只返回坐标信息，不产生 diffRatio，因此不会触发自动回滚。如果你在 browser-eval 后发现关键元素位置偏差很大（如 >5px），可以自行撤销最近的修改（重新写入文件），或者继续调整后再 verify——verify 阶段的自动回滚会保护你。
- Verify 后诊断与读图对比：先看 verify stdout 的 \`alignmentDiagnostics\` 摘要和 \`alignment-diagnostics.json\` 的 \`positionIssues\`，只批量修复真正会改变结构结果的布局/资产问题。若 positionIssues 为空或只剩文本 width/height、glyph 度量、抗锯齿、字重/字体渲染或 1-2px 边缘偏差，即使 diffRatio 仍高也必须停止猜字体、阴影、z-index、overflow 等无依据参数。只有诊断缺失/报错，或诊断无法解释区域级问题时，再读取 verify stdout 的 \`artifacts.renderPngPath\`（当前 HTML 渲染）和 \`artifacts.svgPngPath\`（原 SVG 参考），列出区域级差异清单后一次性批量修复。**任何情况下都不要读取 artifacts.diffPngPath / diff.png**（像素差异热力图，对定位问题帮助小且极耗 token）。
- Verify 螺旋停损：每轮 verify 后先看是否还有结构性问题，再一次性批量修复；禁止一次只改一个元素的 1-3px left/top。若当前最佳 diffRatio 已低于 5%，本轮执行超过 15 分钟，并且相邻两次 verify 的 diffRatio 改善都 < 0.1 个百分点（绝对值降幅 < 0.001），verify stdout 会给出 stopLoss 建议；看到该建议后不要继续微调，保留当前最佳版本停止，转去别处或结束。若出现反弹且诊断没有新的结构性问题，也保留当前最佳版本停止。
- 低收益小问题停损：当剩余问题只是轻微文本偏移、文本 width/height 度量差、抗锯齿、字重/字体渲染、1-2px 抖动、小面积颜色差时，不论 diffRatio 是否低于 0.05，最多围绕同一问题做一次修复和一次复验；若复验 diffRatio 没有下降至少 0.001，禁止继续实验、查源码、查字体、拆字符、改 font-smoothing/text-rendering 或反复改 DOM 结构，直接保留当前最佳版本并结束。

## 最小范例（仅示意结构，按实际数据填坐标）
重复/同构区：
\`\`\`html
<ul class="grid">
  <li class="cell"><img class="cell__img" src="./assets/a.png" /><span class="cell__title">标题</span></li>
</ul>
\`\`\`
\`\`\`css
.grid { position:absolute; left:32px; top:48px; display:grid; grid-template-columns:repeat(2,330px); gap:16px 20px; }
.cell { position:relative; } .cell__img { width:330px; height:186px; object-fit:cover; }
\`\`\`
自由叠放图形区（绝对定位 + z-index 按 inspectIndex）：
\`\`\`html
<div class="layered-region">
  <img class="layered-region__bg" src="./assets/bg.png" />
  <img class="layered-region__art" src="./assets/art.png" />
  <span class="layered-region__label">标题</span>
</div>
\`\`\`
\`\`\`css
.layered-region { position:relative; width:100%; height:100%; }
.layered-region__bg { position:absolute; left:0; top:0; width:100%; height:100%; z-index:1; }
.layered-region__art { position:absolute; left:10px; top:77px; width:316px; height:203px; z-index:2; }
.layered-region__label { position:absolute; left:348px; top:93px; z-index:3; }
\`\`\`

完成后简短说明产物是否已写齐。
`.trim();
}

function buildUserModuleRevisionPrompt({
  outputFormat,
  module,
  userInstructions,
}: {
  outputFormat: OutputFormat;
  module: SvgVerticalModule;
  userInstructions: string;
}) {
  const sourceFragmentFileName = getSourceFragmentFileName(outputFormat);
  return `
## 用户指定模块修复（模块 ${module.id}）

用户调整要求:
${userInstructions}

outputFormat: ${outputFormat}

先阅读当前模块产物（preview.fragment.html、module.css、manifest.json${outputFormat === "html" ? "" : `、${sourceFragmentFileName}、source-data.json`}）和 module-semantic.json。把用户要求转化为源文件修改，保持语义结构完整。

## 视觉实现优先级
- 禁止先用 CSS 重画复杂视觉再把 PNG 当备选。
- 只有纯色背景、单层边框、简单圆角、简单横条/竖条、状态圆点、分隔线允许 CSS；禁止手绘渐变、纹理、阴影、clip-path、mask、伪元素组合。
- 需要使用 gradient/clip-path/mask/::before/::after 才能接近原图时，优先导出 PNG，不要继续堆 CSS。
- generatedAssets 只代表已经按需导出的资源，可能为空；非文本视觉样式仍默认图片优先，需要时从 module-semantic.json 的 nodes 选择 nodeId，用工具导出新的 SVG 节点为 PNG。但禁止把整张卡片、整个模块等大块区域直接拍成单张图片偷懒。
- 文本边界仍以 module-semantic.json 的 textBlocks 为准：禁止导出/烤进图片的只有 textBlocks 对应的预处理 DOM 文本；导出资产里包含 textBlocks 未覆盖的装饰字、徽章字、截图内文字或图片自身文字是允许的，不要为清理这些非预处理文本反复拆图。

完成后可运行局部校验，但要有停损：同一模块/同一区域相邻两次 verify 若每次 diffRatio 改善都小于 0.1 个百分点，就不要继续追这个区域；若只剩文本 width/height 度量差、轻微文本偏移、抗锯齿、字重/字体渲染、1-2px 抖动、小面积颜色差这类小问题，不论 diffRatio 是否低于 5%，最多修一次并复验一次，复验没有改善就停止；不要运行整页 verify。
`.trim();
}

function buildUserModuleGuidancePrompt({
  module,
  userInstructions,
}: {
  module: SvgVerticalModule;
  userInstructions: string;
}) {
  return `
## 用户实时引导（模块 ${module.id}）

用户在你执行当前模块时插入了一条实时引导。请把它作为当前对话的最新用户消息处理，而不是新的修复任务。

用户原文:
${userInstructions}

要求：
- 这是执行过程中的方向调整、提醒、确认或停止信号。
- 不要默认读取文件、不要默认运行 verify/browser-eval、不要默认修改产物。
- 只有用户原文明确要求具体改动时，才按当前上下文做最小必要修改。
- 如果用户表达认可、保持当前、停止继续等意思，就自然停止本模块后续优化，简短回复即可。
`.trim();
}

export {
  buildAgentUnitPrompt,
  buildAgentUnitFollowupBasePrompt,
  buildUserModuleGuidancePrompt,
  buildUserModuleRevisionPrompt,
  resolveModuleOutputFormat,
  getSourceFragmentFileName,
};
