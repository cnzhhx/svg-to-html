const EXPORT_SVG_NODE_TOOL_TEMPLATE =
  'browser-session_export_svg_node({ moduleDir: "<module-dir>", nodeIds: ["<node-id>"], output: "assets/<name>.png", padding: 0 })';

const SEMANTIC_READ_POLICY = [
  "按 inputContract.focusOrder 阅读。",
  "textBlocks 是 DOM 文本主依据，layoutTargetRegion 是首选文本容器框。",
  "generatedAssets 只记录 agent 已经按需导出的资产，模块开始时可以为空；不要假设语义预处理已预导出视觉资源。",
  "视觉样式默认尽量图片化；agent 应从 nodes 的 nodeId/inspectIndex/bbox/semantic 判断需要导出的节点，并通过 guidance.exportSvgNodeTool 按需导出。",
  "nodes[].visualEffects 若存在，是由 SVG filter 解析出的轻量视觉提示，可辅助判断简单边缘阴影、分隔线等效果；edge/edges 表示效果靠近的边，仍需结合节点几何和截图判断实现方式。",
  "nodes/svgNodeAssets 用于分组、覆盖关系、相对位置和按需导出判断，不要逐节点翻译成 HTML。",
].join("\n");

const LAYOUT_TARGET_RULE =
  "textBlocks[].layoutTargetRegion 是宿主优先推荐的 DOM 文本容器框；textRegion 仅作为合理性检查。";

const INPUT_CONTRACT_INSTRUCTION = [
  "使用 textBlocks/textResources 还原 DOM 文本；textBlocks/textResources 未覆盖的内容不得以截图或资产为依据自行识别为 DOM 文本。generatedAssets 可能为空，非文本视觉样式应由 agent 基于截图和 nodes 自主判断，并通过 guidance.exportSvgNodeTool 按需导出。",
  "先根据模块职责组织语义 DOM；存在重复/连续/同构内容时，优先还原为统一父容器和可复用 item/card/tab/token 结构。",
  "若两个可见节点明显重叠，可将更大的 inspectIndex 视为更靠上；证据不足时，优先保持语义结构正确和布局稳定。",
].join("\n");

type SemanticProbeNode = {
  attrs: Record<string, string>;
  bbox: { x: number; y: number; width: number; height: number };
  id: string;
  inspectIndex: number;
  tag: string;
  textContent?: string;
};

type SemanticProbeSheetCell = {
  column: number;
  id: string;
  ordinal: number;
  row: number;
};

const roundBox = (box: { x: number; y: number; width: number; height: number }) => ({
  height: Number(box.height.toFixed(3)),
  width: Number(box.width.toFixed(3)),
  x: Number(box.x.toFixed(3)),
  y: Number(box.y.toFixed(3)),
});

const compactAttrs = (attrs: Record<string, string>) => {
  const entries = Object.entries(attrs).slice(0, 10);
  return Object.fromEntries(entries);
};

const buildVisionPrompt = ({
  cells,
  moduleHeight,
  moduleWidth,
  nodes,
}: {
  cells: SemanticProbeSheetCell[];
  moduleHeight: number;
  moduleWidth: number;
  nodes: SemanticProbeNode[];
}) => {
  const cellById = new Map(cells.map((cell) => [cell.id, cell] as const));
  const nodeFacts = nodes
    .map((node) => ({
      attrs: compactAttrs(node.attrs),
      bbox: roundBox(node.bbox),
      id: node.id,
      index: node.inspectIndex,
      sheetColumn: (cellById.get(node.id)?.column ?? 0) + 1,
      sheetOrdinal: cellById.get(node.id)?.ordinal ?? 0,
      sheetRow: (cellById.get(node.id)?.row ?? 0) + 1,
      tag: node.tag,
      textContent: node.textContent ?? "",
    }))
    .map((node) => JSON.stringify(node))
    .join("\n");
  const cellLegend = cells
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        left.row - right.row ||
        left.column - right.column,
    )
    .map(
      (cell) =>
        `${cell.ordinal}. ${cell.id} (row ${cell.row + 1}, col ${cell.column + 1})`,
    )
    .join("\n");

  return `这是一张 SVG 模块 (${moduleWidth}x${moduleHeight}px) 的单节点文本判定图。
每个格子里只有一个 SVG 节点的局部视觉裁片。
节点既可能是单个叶子图形，也可能是一个紧凑的容器节点局部组图。
你只能基于当前格子的单个节点整体判断，不能跨格子分组推理。
图中格子按“从左到右、从上到下”的顺序编号，节点映射如下：
${cellLegend}

重要说明：
- 格子顶部如果出现很小的序号或节点 id，那只是辅助定位，不属于节点内容，必须忽略。
- 格子里的浅色或深色棋盘、纯色底、边框只是系统为了展示透明或低对比节点添加的辅助背景，不属于节点内容，也不能作为是否文本的依据。
- 每个格子只展示一个节点一次。读取文字时只读节点本身的可见笔画，不要把背景、边框、序号、节点 id 或其他辅助 UI 当作文字内容。

节点事实：
${nodeFacts}

请输出严格 JSON 数组。每项格式：
{
  "id": "n0001",
  "isPureText": true,
  "text": "如果能明确读出文字则填写，否则空字符串",
  "lineCount": 1,
  "visualLines": ["第一条视觉行", "第二条视觉行"]
}

判断规则：

1. isPureText —— 只做“可还原为 DOM 文本 / 不适合 DOM 文本”的二分类：
   - true：适合直接重建为 DOM 文本的普通文字（标题、段落、按钮文案、标签、数字等）。节点可以是 path 转曲文字；只要节点自身的可见笔画能独立读成普通排版文字，且用常规 DOM 文本 + 基础字体/颜色/字号/行高即可合理还原，就判 true。
   - false：非文本图形，或虽然包含字形但不适合拆成 DOM 文本的视觉文字。出现以下任一特征即判 false：
     • 字间距异常大：相邻字符之间的留白明显大于常规排版。节点事实中的 computed-letter-spacing 若 ≥2px，或目测留白超过字符高度的约 5%，即视为异常大；
     • 明显倾斜/斜体、字符被拉伸/压扁/扭曲，或使用了特殊字形（如书法体、卡通体、像素体等）；
     • 文字带有渐变填充、多层描边、投影/发光、立体/浮雕、纹理填充、剪切蒙版等复杂样式，无法仅靠 color + font-family 还原；
     • 文字与背景装饰、徽章、图标、异形底框已形成视觉整体，拆分后任一部分失去原意。
   不要因为节点 bbox 较大、透明区域较多、文字颜色较淡、或辅助背景显眼而判 false；只看节点自身可见笔画是否是普通可读文本。

2. text：
   - isPureText=true 时必填，填你能读出的实际文字。
   - isPureText=false 时不填，置为空字符串。
   - 多行文本节点：text 可以填所有行的可见字符按从左到右、从上到下的阅读顺序直接拼接后的文本。

3. lineCount：
   - isPureText=true 时必填，按视觉上实际看到的行数填写（看到几行填几）。
   - isPureText=false 时不填。

4. visualLines：
   - isPureText=true 时尽量必填，尤其多行文本必须填。
   - 每一项代表最终视觉上实际看到的一行文字，按从上到下、从左到右排序；不是语义段落。
   - 不要判断这些换行是不是由宽度溢出造成；看到几行就输出几行。长段落如果在视觉上自动折成多行，也必须拆成多项。
   - 只输出字符串数组，不要输出坐标、宽高或其他行框信息。

只输出 JSON，不要额外说明。`;
};

export {
  buildVisionPrompt,
  EXPORT_SVG_NODE_TOOL_TEMPLATE,
  SEMANTIC_READ_POLICY,
  LAYOUT_TARGET_RULE,
  INPUT_CONTRACT_INSTRUCTION,
};
export type { SemanticProbeSheetCell };
