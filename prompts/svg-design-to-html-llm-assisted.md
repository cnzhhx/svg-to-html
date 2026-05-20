# SVG 设计稿转 HTML 工作流

## 目标
- 输入：`workspace/sessions/当前会话目录/*.svg`
- 输出：同目录 `*.html`（纯还原页）+ `*.compare.html`（对照页）
- 验收目标：HTML/CSS 独立重建页面，可与 SVG 对照验证

## 快速入口
```bash
pnpm exec tsx src/cli/generate-design.ts sessions/当前会话目录/设计稿.svg
pnpm exec tsx src/cli/verify-design.ts sessions/当前会话目录/设计稿.svg
```
如果本 session 已生成 `artifacts/modules/module-regions.diff.json`，所有 `verify-design` 命令都必须追加 `--regions workspace/sessions/当前会话目录/artifacts/modules/module-regions.diff.json`，这样报告会给出 module-level diff 定位。修复过程中的低成本自检可按需追加 `--fast`；如果需要 OCR、文本盒、布局盒、工作流 lint 或最终输出策略结果，就运行完整验证。不要在每个小改后都跑验证；先把同一区域、同一层级或同一类问题合并成一批修改，再用一次 fast verify 检查整体方向。单个 agent turn 内最多运行 4 次 `verify-design`，每次验证前都要尽可能批量修复当前报告中能判断的高优先级问题，并在 4 次以内完成验证闭环。

## 核心原则
1. 设计来源只认目标 SVG、同目录设计资源和用户补充说明
2. 禁止把 `src/`、已有 HTML、mock、未校验 agent 产物当设计来源
3. `*.html` 必须是纯 HTML/CSS 重建页，不能引用或内联整张原始 SVG
4. 普通 UI 文案、标题、标签、按钮、说明、名称、数值、状态等文本必须恢复成真实 HTML 文本
5. 位图可用于原设计本来就是位图的部分，也可用于从 SVG 单个视觉节点导出的模块局部 PNG 资产；普通文本仍必须是真实 DOM
6. 验证只把 PNG、OCR、diff 当校验依据，不当设计来源
7. 遇到 icon、渐变、滤镜、复杂装饰、位图纹理、logo/艺术字等视觉元素，禁止用 CSS/HTML 手画或凭感觉重绘；必须根据位置、bbox、层级和 paint order 去 SVG 中定位对应节点，导出模块局部 PNG 后引用
8. 标题、标签、按钮文案、说明、名称、数值、状态等变量文本必须保持可见、可编辑、可被 tracked text-layout 校验
9. 任何 PNG 资产在使用前都要确认没有承载普通/动态 UI 文本；manifest 标记为 mustUse 的静态资产如果包含可读文字，不要再叠加重复 DOM 文本；其他普通 UI 文本必须用 DOM 重建

## 失败模式
以下做法一律算失败：
1. 用 img/object/embed/iframe 直接展示整张原始 SVG
2. 在 `*.html` 中直接内联整份原始 SVG 源码
3. 把结果做成结构检查页、注释页、SVG 播放器
4. 因为复杂就把大块区域降级成整图或占位框
5. 从业务实现、旧 HTML、mock 反推设计结构
6. 用大 SVG/原始裁剪作为视觉层后，把真实 DOM 设为 `opacity: 0`、`visibility: hidden` 或 `display: none`
7. 隐藏或弱化真实 DOM 文本后再用整页、整模块、大区域截图、PNG、SVG crop 覆盖
8. 用从原图、截图、OCR 结果或验证产物裁出的文字图片/SVG 承担普通 UI 文本显示
9. 复制原始 SVG 或另存为新的 SVG/图片资源来伪装成背景资源；整页、整模块、大裁片资源里只要 OCR 能读出文字，就不是合格背景
10. 用 CSS/HTML/伪元素/border/box-shadow/clip-path 手画 icon、渐变、复杂装饰或滤镜效果，而不是回到 SVG 定位对应视觉节点并导出 PNG
11. 把多个没有共同父级的 SVG sibling 节点手工拼成一个普通图标/控件资产；只有这些节点共同构成不可拆的艺术字、品牌字形或强装饰视觉文字时才允许合成，并且必须声明 textTreatment

例外：compare 页左侧允许引用原始 SVG；宿主明确允许的静态资产可按 allowed-assets 清单使用。

## 工作步骤

### 1. 读 SVG 源码
直接读目标 SVG 文本，重点：viewBox、`<g>` 分组层级、rect/path/ellipse/image/use、clipPath/mask/transform、内嵌位图。先得到结构树再写代码。

### 2. 划分模块与容器
- 开工前先读 `container-layout.md` 的 Root Children / Repeated Groups / Container Tree / Member Alignment Hints；如果有 `structure-draft.json`，用它作为初始 DOM 骨架参考
- 先建立自然树状 DOM 结构，页面根节点下只放顶层模块容器；模块内部也要先建 header/nav/toolbar/list/card/item/text-area 等父容器，再放文本、图标、壳层和装饰
- 对 repeat-group 必须渲染成统一父容器（list/row/grid）加多个 article/item，同类 item 内部尽量保持一致子结构；不要把重复卡片的文本、底板、图标拆成一批彼此无关的同级绝对定位节点
- OCR 文本节点要归入最近的语义父容器：标题进 header/title，tab 文本进 tabs/tab，卡片说明进对应 card/text-area，按钮文案进 button/action；绝对定位坐标优先相对最近父容器换算
- 如果视觉上是一张卡、一行工具栏、一个控件或一个列表项，DOM 上也必须有共同父节点；不要把大量 OCR 文本、图标和装饰直接平铺在 `.design-page` 或大 workspace/panel 下
- 默认优先 `absolute` 定位；只有明确列表/栅格/重复结构才用流式布局
- 若 OCR 明确表明结构不合理，允许调整文本容器归并

### 3. 处理文本
- path 化文字优先恢复为真实 HTML 文本
- 禁止“隐藏/半透明 DOM 文本 + 文字裁片覆盖”的实现；DOM 文本本身必须清晰可见
- 对 OCR 识别不准的文字，先按 SVG/OCR/上下文修正文本内容，不允许用图片裁片绕过
- 默认：`font-family: PingFang SC`、`font-style: normal`、单行 `line-height: 1`、多行 `line-height: 1.3`、`letter-spacing: 0`
- 文本位置参照 SVG 文字盒，不要写成手调偏移
- 文本节点和承载文本的容器禁止使用 CSS/SVG `transform`（尤其是 `scale`、`scaleX`、`scaleY`、`matrix`、`skew`）来拉伸、压扁或校准文字；文字尺寸只能通过 `font-size`、`font-weight`、`line-height`、`letter-spacing`、`width/height/position` 等正常排版属性调整，避免字形变形
- OCR 里 1~2 个字符、符号、乱码或和小图标/控件强重叠的短 token，先用 SVG 节点、容器语义和截图核对它到底是文字还是图标；不要把定位点、箭头、播放/暂停、勾选、关闭、装饰符号等误渲染成普通 DOM 文本。确认是图标/装饰时，从 SVG 中定位对应单个视觉节点并导出 PNG 资产，只有确认是业务文案/数字时才用 tracked 文本。
- 如果 text-box 报告显示大量同类文本整体更窄、更矮、下移或字号偏小，先按容器/重复模板/文本层级做一批字体策略调整（`font-size`、`font-weight`、`line-height`、`letter-spacing`、文本容器位置），不要逐个 token 手调，也不要用 transform 缩放文字。
- 所有 `rem` 值四舍五入到 `x.xxxrem`；单行文本不设 `width`
- SVG 换行不等于 HTML 必须保留同样换行

### 4. 处理 SVG 视觉资产
- 禁止手写或近似重绘 icon、渐变、滤镜、复杂装饰、复杂描边、阴影、高光、纹理、logo 和艺术字；只能通过 SVG 节点定位、导出 PNG、按原位置和层级贴回页面
- 从 SVG 节点生成模块局部 PNG 时，使用官方 `export-svg-node-asset.ts` CLI 从当前模块 `module.svg` 的指定节点透明导出，并追加当前 session 注入的显式 `--scale`；不要临时手写 Chrome/PIL/截图裁剪脚本
- CSS 尺寸和 `manifest.generatedAssets[].box` 使用渲染后的局部坐标；不要用导出 PNG 的文件像素尺寸反推布局
- 单个 SVG 节点是默认允许的资产边界：`path`、`rect`、`image`、`use`、`g` 等都可以作为一个原子视觉节点；如果该单节点只是普通文本/标签/数值且没有 logo、艺术字形、装饰或图形效果绑定，必须改成 DOM 文本，不能切图
- 如果一个 icon 或装饰由多个 path 组成，先找承载它们的共同父节点（如 `g`、`use`、带 mask/clip/filter 的父层）；找到共同父节点时按这个单父节点导出，不要自己临时拼 sibling
- 多个没有共同父级的 SVG 节点一般不能合成一个资产。唯一窄例外：这些节点共同构成不可拆的艺术字、品牌字形、强装饰视觉文字或与图形交织的 lettering，拆开会破坏视觉字形；这种资产必须登记为视觉文字/艺术字用途，并声明 `textTreatment`
- 导出 PNG 前先检查 OCR / Vision Text Blocks / 节点内容 / bbox 覆盖关系，确认没有把标题、按钮文案、标签、名称、数值、状态等普通或动态文本带进图片；如果带了普通文本，拆成“无文本视觉资产 + DOM 文本”
- 禁止从宿主或校验流程生成的 PNG 上裁剪资产，包括但不限于 `module-render.png`、`module-text-source.png`、`svg.png`、`html.png`、`diff.png`、整页渲染图、模块渲染图和 OCR/verify 截图；这些图片只可用于观察和校验，不可作为资产来源
- 资产必须放在本模块 `assets/` 目录并写入 `manifest.generatedAssets`，包含 `path`、`box`、`assetRole`、`textTreatment`；HTML 中只引用登记后的相对路径

### 5. 处理位图与装饰
- 内嵌 base64 位图可导出为模块局部正常资源
- 复杂装饰必须从 SVG 节点导出边界清晰的模块局部 PNG 资产；HTML 层不要用整页或整模块图片兜底，也不要用 CSS 重新画
- 不要把复杂区域切成大图拼版规避结构还原
- 不要把普通文字模糊、打码、马赛克、遮罩或抹掉后继续把那张图当成无文字资源；普通 UI 文本必须用 HTML/CSS 重建外壳并保留为真实 DOM
- 整页/整模块 shell、来源于整页或整模块的大裁片资源不能作为最终视觉层
- 裁片里如果含可读普通 UI 文本，先拆分：保留装饰背景，文字改为可见 DOM
- 最终 HTML 引用的背景资源必须是“纯背景”，不能用整页/整模块/大区域资源承载普通 UI 文本

### 6. 执行验证
`verify-design --fast` 是可选的低成本自检工具，只跑渲染、像素 diff 和模块区域统计，适合判断一批相关修改是否让像素或模块 diff 变好。单个 agent turn 内最多运行 4 次 `verify-design`。每次验证前先阅读已有报告、截图和源码，把硬门禁、主要容器错位、文本内容错误、同一区域的尺寸/位置/层级问题尽量一次处理完；不要改一个 `left/top/font-size`、一句文案或一个颜色就立刻验证，也不要把 fast verify 当成逐值 A/B 调参循环。若一次批量修复后 diff 只剩很小改善或开始反复波动，停止微调并简短说明剩余风险，交给宿主流程的后续验证。需要确认 OCR、文本盒、布局盒、工作流 lint 或最终输出策略时，运行完整 `verify-design`；否则把完整验证留给宿主流程的最终校验。PNG 和 OCR 只是验证产物，不是设计来源。
即使整体 diff 不高，diff-insights 里的局部 cluster、grid hotspot、hairline hotspot 仍然可能暴露明显局部错位；优先修整这些热点对应的容器、图片槽、边线、图标和文本层级，而不是只看总 diffRatio。

## 项目换算规则
- 当前 session 的具体换算规则会由宿主运行时注入到这里。
- 如果你是在仓库里直接阅读本提示词文件，而不是读取宿主注入后的完整 agent prompt：实际换算规则以当前 session 的 `SVG 渲染缩放`/`scale` 配置为准；不要套用固定 1x 或 2x 假设。

## 验收标准
1. 已产出同名 `*.html` 和 `*.compare.html`
2. `*.html` 主画面是 HTML/CSS 渲染结果
3. 核心节点已按 SVG 视觉资产还原，层级一致，文本位置基本一致
4. 已运行 verify 并处理主要偏差

## 何时中止
关键文本全部 path 化且无法识别、核心视觉严重依赖复杂向量效果无法 HTML 化时，报告阻塞点和缺失信息，不要退回到"把原 SVG 塞进 HTML"。
