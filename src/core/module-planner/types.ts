import type { ContainerLayoutReport } from "../container-layout/types.js";
import type { SvgLayoutResult } from "../svg-layout.js";
import type { Box } from "../utils.js";

export type ModulePlannerMode = "auto" | "script" | "model";
type SelectedModulePlanner = "single-page" | "model";

export type ModuleKind =
  | "global-shell"
  | "section"
  | "header"
  | "sidebar"
  | "main"
  | "right-panel"
  | "list-grid"
  | "overlay"
  | "model-region";

type ModulePlannerConstraints = {
  avoidSplittingCardsOrRepeatedItems: boolean;
  avoidSplittingVisibleText: boolean;
  preferSemanticSections: boolean;
  smallDecorationsBelongToNearestModule: boolean;
};

export type ModelPlannerRequest = {
  constraints: ModulePlannerConstraints;
  design: {
    height: number;
    name: string;
    previewImagePath: string;
    previewImages?: ModelPlannerPreviewImage[];
    sourceSvgPath: string;
    width: number;
  };
  geometryHints?: {
    note: string;
    sourceBoxes: Array<{
      box: Box;
      id: string;
      kind: ValidationSourceBox["kind"];
    }>;
  };
  mode: "auto" | "single" | "vertical";
};

export type ModelPlannerPreviewImage = {
  fullHeight: number;
  height: number;
  imagePath: string;
  kind: "overview" | "tile";
  label: string;
  offsetY: number;
  scale: number;
  width: number;
};

type ModelPlannerRegion = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type ModelPlannerModule = {
  id?: string;
  kind?: string;
  reason?: string;
  region?: ModelPlannerRegion;
};

export type ModelPlannerResponse = {
  modules?: ModelPlannerModule[];
  strategy?: string;
};

export type ModulePlanValidationIssue = {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  regionIds?: string[];
  severity: "error" | "warning";
};

export type ModulePlanValidationSummary = {
  errorCount: number;
  errors: ModulePlanValidationIssue[];
  passed: boolean;
  warningCount: number;
  warnings: ModulePlanValidationIssue[];
};

export type ModulePlanValidationResult = ModulePlanValidationSummary & {
  sourceCoverage?: {
    coveredCount: number;
    sourceBoxCount: number;
    uncoveredIds: string[];
  };
};

export type ModulePlannerMetadata = {
  fallbackReason?: string;
  modelAttempted: boolean;
  requested: ModulePlannerMode;
  retries: number;
  selected: SelectedModulePlanner;
  validation?: ModulePlanValidationSummary;
};

export type ModelPlannerInput = {
  artifactDir: string;
  constraints: ModulePlannerConstraints;
  containerLayout?: ContainerLayoutReport;
  design: {
    height: number;
    name: string;
    previewImagePath: string;
    previewImages?: ModelPlannerPreviewImage[];
    sourceSvgPath: string;
    width: number;
  };
  mode: "auto" | "single" | "vertical";
  moduleDir: string;
  plannerRetries: number;
  svgLayout?: SvgLayoutResult;
  viewport: Box;
};

export type NormalizeModelPlanInput = {
  containerLayout?: ContainerLayoutReport;
  response: ModelPlannerResponse;
  svgLayout?: SvgLayoutResult;
  validation: ModulePlanValidationResult;
  viewport: Box;
};

export type ValidateModelPlanInput = {
  containerLayout?: ContainerLayoutReport;
  response: unknown;
  viewport: Box;
};

export type ValidationSourceBox = {
  box: Box;
  id: string;
  kind: "container" | "repeat-group";
};
