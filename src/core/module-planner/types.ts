import type { ContainerLayoutReport } from "../container-layout/types.js";
import type { SvgLayoutResult } from "../svg-layout.js";
import type { Box } from "../utils.js";
import type {
  PlannerOcrBlock,
  PlannerShellEntry,
} from "../svg-vertical-modules/types.js";

export type ModulePlannerMode = "auto" | "script" | "codex";
export type SelectedModulePlanner = "single-page" | "model";

export type CodexModuleKind =
  | "global-shell"
  | "section"
  | "header"
  | "sidebar"
  | "main"
  | "right-panel"
  | "list-grid"
  | "overlay"
  | "model-region";

export type ModulePlannerConstraints = {
  avoidSplittingCardsOrRepeatedItems: boolean;
  avoidSplittingVisibleText: boolean;
  preferSemanticSections: boolean;
  smallDecorationsBelongToNearestModule: boolean;
};

export type CodexPlannerRequest = {
  constraints: ModulePlannerConstraints;
  design: {
    height: number;
    name: string;
    previewImagePath: string;
    previewImages?: CodexPlannerPreviewImage[];
    sourceSvgPath: string;
    width: number;
  };
  geometryHints?: {
    note: string;
    ocrBlocks: Array<{
      bbox: Box;
      id: string;
      text?: string;
    }>;
    sourceBoxes: Array<{
      box: Box;
      id: string;
      kind: ValidationSourceBox["kind"];
    }>;
  };
  mode: "auto" | "single" | "vertical";
};

export type CodexPlannerPreviewImage = {
  fullHeight: number;
  height: number;
  imagePath: string;
  kind: "overview" | "tile";
  label: string;
  offsetY: number;
  scale: number;
  width: number;
};

export type CodexPlannerRegion = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type CodexPlannerModule = {
  id?: string;
  kind?: string;
  reason?: string;
  region?: CodexPlannerRegion;
};

export type CodexPlannerResponse = {
  modules?: CodexPlannerModule[];
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

export type CodexModulePlannerInput = {
  artifactDir: string;
  constraints: ModulePlannerConstraints;
  containerLayout?: ContainerLayoutReport;
  design: {
    height: number;
    name: string;
    previewImagePath: string;
    previewImages?: CodexPlannerPreviewImage[];
    sourceSvgPath: string;
    width: number;
  };
  mode: "auto" | "single" | "vertical";
  moduleDir: string;
  ocrBlocks: PlannerOcrBlock[];
  plannerRetries: number;
  shellManifest: PlannerShellEntry[];
  svgLayout?: SvgLayoutResult;
  viewport: Box;
};

export type NormalizeCodexPlanInput = {
  containerLayout?: ContainerLayoutReport;
  ocrBlocks: PlannerOcrBlock[];
  response: CodexPlannerResponse;
  shellManifest: PlannerShellEntry[];
  svgLayout?: SvgLayoutResult;
  validation: ModulePlanValidationResult;
  viewport: Box;
};

export type ValidateCodexPlanInput = {
  containerLayout?: ContainerLayoutReport;
  ocrBlocks: PlannerOcrBlock[];
  response: unknown;
  shellManifest: PlannerShellEntry[];
  viewport: Box;
};

export type ValidationSourceBox = {
  box: Box;
  id: string;
  kind: "container" | "ocr" | "repeat-group" | "shell";
};
