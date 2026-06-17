import path from "node:path";

import {
  loadComponentLibraryDescriptor,
  writeTextFile,
} from "../../core/component-library/index.js";
import type {
  ComponentLibraryAgentContext,
  ComponentLibraryDescriptor,
  ComponentLibrarySessionRef,
} from "../../core/component-library/types.js";
import { writeJsonFile } from "../../core/utils.js";
import type { Session } from "../../session-store/types.js";

const escapeMarkdownCell = (value: unknown) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();

const formatComponentCatalog = (descriptor: ComponentLibraryDescriptor) => {
  const rows = descriptor.components.map((component) =>
    [
      component.name,
      component.displayName ?? "",
      component.category ?? "",
      component.importName ?? component.name,
      component.tag ?? component.importName ?? component.name,
      component.path,
      (component.docsPaths ?? []).join(", "),
      (component.examplePaths ?? []).join(", "),
      component.description ?? "",
    ]
      .map(escapeMarkdownCell)
      .join(" | "),
  );
  return [
    "| name | displayName | category | importName | tag | path | docsPaths | examplePaths | description |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

const createComponentLibraryContextMarkdown = ({
  descriptor,
  descriptorPath,
  sourceDir,
}: {
  descriptor: ComponentLibraryDescriptor;
  descriptorPath: string;
  sourceDir: string;
}) =>
  `
# Component Library Context

- id: ${descriptor.id}
- name: ${descriptor.name}
- framework: ${descriptor.framework}
- sourceDir: ${sourceDir}
- descriptor: ${descriptorPath}
- package.name: ${descriptor.package.name}
- package.importPath: ${descriptor.package.importPath ?? descriptor.package.name}
- package.importMode: ${descriptor.package.importMode ?? "named"}

## Usage Contract

- 当前 session 已选择组件库，输出格式为 ${descriptor.framework}。agent 必须只看 ${descriptor.framework} 版本的公开 API 和用法；如果组件库同时支持多框架（如底层是其他框架，外层有 Vue/React 包装器），不要阅读底层框架实现或其他框架目录，只看当前 session 对应框架的文档、示例和类型定义。
- **sourceDir 是源码磁盘路径，仅用于本地阅读组件实现；所有 import 必须使用 package.name（${descriptor.package.name}）或 package.importPath（${descriptor.package.importPath ?? descriptor.package.name}），禁止把 sourceDir 路径写进 import from，禁止猜测其他包名。**
- 组件库 session 采用视觉优先流程：先看模块参考图/叠加图判断通用 UI 类型和语义单元，再用 module-semantic.json 的 textBlocks、summaryStats、guidance 等轻量字段落地；generatedAssets 只代表已按需导出的资产，启动时可以为空。需要视觉资源时再从 nodes 选择节点导出，不要把全量 SVG nodes 作为组件选择的首要依据。
- 先把当前模块拆成通用 UI 语义单元；adoption plan 和组件目录只作为候选提示，公开 API 能自然表达该语义单元时优先采用组件库组件。
- 语义单元按结构和交互判断，例如 action control、input/select/filter、navigation、collection/repeated item、overlay、status badge、media/icon-only affordance 等；不要按业务文案、页面领域或单个像素特征硬匹配。
- 先根据下方目录或 component-library.json 的 name/displayName/category/description/keywords 粗选少量候选组件；不要因为名称局部相似就直接使用，也不要为了“使用组件库”而包一层无意义组件。
- 只阅读候选组件 path 目录、附近 README/docs/examples、以及必要的 package 入口文件来确认公开 API；不要扫描或 dump 整个组件库仓库。
- 使用组件的条件：组件的公开 props/slots/children/config 能表达该语义单元的主要结构、可见状态、禁用/选中/加载等状态和必要子内容；若公开 API 不适合该模块结构，可以直接用普通 HTML/CSS。
- 组件库源码和样式只读：不要修改组件库目录下的任何文件，不要改组件 CSS/SCSS/Less，也不要在本模块 CSS 里覆盖组件内部 class 或选择器。
- 调整组件只能使用公开 API，例如 props、slots、children、组件配置、主题 token、CSS variables，或在组件外层 wrapper 上做位置/尺寸布局。
- 若组件目录里有 docsPaths/examplePaths，优先阅读这些文件来确认公开 API；不要根据内部实现私有 class 猜用法。
- preview.fragment.html 仍必须是普通 HTML 预览片段，方便局部校验；source fragment 可在合适时使用组件库组件。
- **不要在 source fragment 里写 import/export**；宿主 merge 会根据 source fragment 中出现的组件库顶层组件标签自动导入组件和样式。尤其不要自己猜测 import 路径写死 package name。
- manifest 不需要写 usedComponents 或 componentDecision；除非必须覆盖默认 tag/importName，否则不要写组件相关 manifest 字段。子组件（如 Table 内部的 Column、ButtonGroup 内部的 Button）不要单独声明为 usedComponents。
- 若组件状态/props/slots/API 明确无法确认，直接使用普通 HTML/CSS；若本地 framework build 明确失败且无法用公开 API 修复，改回普通 HTML/CSS。

## Components

${formatComponentCatalog(descriptor)}
`.trim();

const createComponentLibraryPlanRef = ({
  descriptor,
  descriptorPath,
  sourceDir,
}: {
  descriptor: ComponentLibraryDescriptor;
  descriptorPath: string;
  sourceDir: string;
}) => ({
  descriptorPath,
  framework: descriptor.framework,
  id: descriptor.id,
  importPath: descriptor.package.importPath ?? descriptor.package.name,
  name: descriptor.name,
  packageName: descriptor.package.name,
  sourceDir,
});

const createComponentLibraryAgentContext = async ({
  modulesRootDir,
  session,
}: {
  modulesRootDir: string;
  session: Session;
}): Promise<ComponentLibraryAgentContext | undefined> => {
  const ref: ComponentLibrarySessionRef | undefined = session.componentLibrary;
  const id = session.componentLibraryId ?? ref?.id;
  if (!id || !ref) return undefined;

  const descriptor = await loadComponentLibraryDescriptor(id);
  if (descriptor.framework !== session.outputFormat) {
    throw new Error(
      `Session component library framework (${descriptor.framework}) does not match outputFormat (${session.outputFormat})`,
    );
  }
  const descriptorPath = ref.descriptorPath;
  const sourceDir = ref.sourceDir;
  const markdownPath = path.join(modulesRootDir, "component-library-context.md");
  const jsonPath = path.join(modulesRootDir, "component-library-context.json");
  const planRef = createComponentLibraryPlanRef({
    descriptor,
    descriptorPath,
    sourceDir,
  });
  await Promise.all([
    writeTextFile(
      markdownPath,
      `${createComponentLibraryContextMarkdown({
        descriptor,
        descriptorPath,
        sourceDir,
      })}\n`,
    ),
    writeJsonFile(jsonPath, {
      ...planRef,
      components: descriptor.components,
      descriptor,
      jsonPath,
    }),
  ]);

  return {
    descriptor,
    descriptorPath,
    framework: descriptor.framework,
    id,
    markdownPath,
    name: descriptor.name,
    sourceDir,
  };
};

export {
  createComponentLibraryAgentContext,
  createComponentLibraryPlanRef,
};
