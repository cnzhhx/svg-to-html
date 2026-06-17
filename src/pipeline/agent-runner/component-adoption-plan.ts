import path from "node:path";

import type {
  ComponentLibraryComponent,
  ComponentLibraryDescriptor,
} from "../../core/component-library/types.js";
import { writeJsonFile } from "../../core/utils.js";
import type { SvgVerticalModule } from "../../core/svg-vertical-modules/types.js";

type ComponentAdoptionIntent = "none" | "optional" | "required";

type ComponentAdoptionCandidate = {
  componentName: string;
  confidence: number;
  reason: string;
  semanticUnit:
    | "action-control"
    | "collection"
    | "input-control"
    | "navigation"
    | "selection-control"
    | "tag-token";
};

type ComponentAdoptionPlanModule = {
  candidates: ComponentAdoptionCandidate[];
  intent: ComponentAdoptionIntent;
  moduleId: string;
  optionalComponents: string[];
  reason: string;
  requiredComponents: string[];
};

type ComponentAdoptionPlan = {
  componentLibraryId: string;
  generatedAt: number;
  modules: ComponentAdoptionPlanModule[];
  schemaVersion: 1;
};

type PlanModuleInput = Pick<SvgVerticalModule, "id" | "kind"> & {
  candidateNodeCount?: unknown;
  reason?: unknown;
};

const normalizeText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const getModuleText = (module: PlanModuleInput) =>
  [
    module.id,
    module.kind,
    normalizeText(module.reason),
  ].join(" ");

const hasComponent = (
  descriptor: ComponentLibraryDescriptor,
  names: string[],
): ComponentLibraryComponent | undefined => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return descriptor.components.find((component) =>
    [component.name, component.importName, component.tag]
      .map((value) => value?.trim().toLowerCase())
      .some((value) => value && wanted.has(value)),
  );
};

const addCandidate = ({
  candidates,
  component,
  confidence,
  reason,
  semanticUnit,
}: {
  candidates: ComponentAdoptionCandidate[];
  component?: ComponentLibraryComponent;
  confidence: number;
  reason: string;
  semanticUnit: ComponentAdoptionCandidate["semanticUnit"];
}) => {
  if (!component) return;
  if (candidates.some((candidate) => candidate.componentName === component.name)) {
    return;
  }
  candidates.push({
    componentName: component.name,
    confidence,
    reason,
    semanticUnit,
  });
};

const classifyModuleCandidates = ({
  descriptor,
  module,
}: {
  descriptor: ComponentLibraryDescriptor;
  module: PlanModuleInput;
}) => {
  const text = getModuleText(module);
  const lower = text.toLowerCase();
  const candidates: ComponentAdoptionCandidate[] = [];
  const nodeCount =
    typeof module.candidateNodeCount === "number"
      ? module.candidateNodeCount
      : 0;

  if (
    /(?:pagination|pager|page\s*size|page\s*number|页码|分页|每页|前往|跳转|条\s*\/?\s*页)/i.test(
      text,
    )
  ) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, ["Pagination", "Pager"]),
      confidence: 0.94,
      reason:
        "module contains page navigation, total/limit, or jump controls; use the library navigation component first",
      semanticUnit: "navigation",
    });
  }

  if (
    /(?:list-grid|table|grid|list|row|column|列表|表格|行|列)/i.test(text) ||
    nodeCount >= 80
  ) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, ["Table", "DataTable", "Grid"]),
      confidence: 0.9,
      reason:
        "module is a repeated collection with multiple fields; use the library collection component first",
      semanticUnit: "collection",
    });
  }

  if (/(?:tag|chip|token|badge|标签|筛选标签|过滤标签|检索项)/i.test(text)) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, ["Tag", "Chip", "Badge"]),
      confidence: 0.84,
      reason:
        "module contains compact removable or status tokens; use the library tag/token component first",
      semanticUnit: "tag-token",
    });
  }

  if (/(?:input|search|keyword|query|搜索|关键词|输入)/i.test(text)) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, ["Input", "Search", "TextField"]),
      confidence: 0.82,
      reason:
        "module contains a text-entry or search affordance; use the library input component first",
      semanticUnit: "input-control",
    });
  }

  if (/(?:select|dropdown|combobox|筛选|选择|下拉)/i.test(text)) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, [
        "Select",
        "Dropdown",
        "Combobox",
        "TreeSelect",
      ]),
      confidence: 0.82,
      reason:
        "module contains a choice or dropdown affordance; use the library selection component first",
      semanticUnit: "selection-control",
    });
  }

  if (
    /(?:button|action|control|submit|download|refresh|clear|按钮|操作|提交|下载|刷新|清除|设置)/i.test(
      text,
    ) ||
    (lower.includes("icon") && nodeCount >= 8)
  ) {
    addCandidate({
      candidates,
      component: hasComponent(descriptor, ["Button"]),
      confidence: 0.78,
      reason:
        "module contains action controls; use the library action component when it can host the visible label or icon",
      semanticUnit: "action-control",
    });
  }

  return candidates.sort((left, right) => right.confidence - left.confidence);
};

const planModule = ({
  descriptor,
  module,
}: {
  descriptor: ComponentLibraryDescriptor;
  module: PlanModuleInput;
}): ComponentAdoptionPlanModule => {
  const candidates = classifyModuleCandidates({ descriptor, module });
  const requiredComponents = candidates
    .filter((candidate) => candidate.confidence >= 0.8)
    .map((candidate) => candidate.componentName);
  const optionalComponents = candidates
    .filter((candidate) => candidate.confidence < 0.8)
    .map((candidate) => candidate.componentName);
  const intent = requiredComponents.length
    ? "required"
    : optionalComponents.length
      ? "optional"
      : "none";
  return {
    candidates,
    intent,
    moduleId: module.id,
    optionalComponents,
    reason:
      intent === "required"
        ? "high-confidence generic UI semantic units were matched"
        : intent === "optional"
          ? "only lower-confidence generic UI semantic units were matched"
          : "no generic component-library semantic unit was matched",
    requiredComponents,
  };
};

const createComponentAdoptionPlan = async ({
  descriptor,
  modules,
  outputPath,
}: {
  descriptor: ComponentLibraryDescriptor;
  modules: PlanModuleInput[];
  outputPath: string;
}): Promise<ComponentAdoptionPlan> => {
  const plan: ComponentAdoptionPlan = {
    componentLibraryId: descriptor.id,
    generatedAt: Date.now(),
    modules: modules.map((module) => planModule({ descriptor, module })),
    schemaVersion: 1,
  };
  await writeJsonFile(outputPath, plan);
  return plan;
};

const getComponentAdoptionPlanPath = (modulesRootDir: string) =>
  path.join(modulesRootDir, "component-adoption-plan.json");

export {
  createComponentAdoptionPlan,
  getComponentAdoptionPlanPath,
};
