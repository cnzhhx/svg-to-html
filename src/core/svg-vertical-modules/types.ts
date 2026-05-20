import type { ContainerLayoutReport } from "../container-layout/types.js";
import type {
  CodexModuleKind,
  ModulePlannerMetadata,
  ModulePlannerMode,
} from "../module-planner/types.js";
import type { ModulePlanQualityReport } from "../module-plan-quality.js";
import type { SvgLayoutResult } from "../svg-layout.js";
import type { Box, Region } from "../utils.js";

export type ModulePlanningRoute = "single" | "model";
export type ModulePlanMode = "auto" | "single" | "vertical";

export type ModuleBox = Box & {
  bottom: number;
  right: number;
};

export type ModuleGap = {
  cutY: number;
  fromY: number;
  height: number;
  reason: string;
  score: number;
  selected: boolean;
  toY: number;
};

export type SerializableRegion = Region & {
  id: string;
};

export type PlannerOcrBlock = {
  assignedContainerId?: null | string;
  bbox: Box;
  id: string;
  text?: string;
};

export type PlannerShellEntry = {
  box?: Box;
  containerId: string;
  status?: string;
};

export type OcrBlocksInput =
  | PlannerOcrBlock[]
  | {
      blocks?: PlannerOcrBlock[];
    };

export type ShellManifestInput =
  | PlannerShellEntry[]
  | {
      entries?: PlannerShellEntry[];
    };

export type SvgVerticalModule = {
  candidateNodeCount: number;
  contentBox: Box;
  diffRegion: SerializableRegion;
  id: string;
  kind: "single-page" | CodexModuleKind;
  nodePaths: string[];
  ocrBlockIds: string[];
  reason: string;
  region: SerializableRegion;
  score: number;
  shellContainerIds: string[];
  sourceContainerIds: string[];
};

export type SvgSharedLayer = {
  contentBox: Box;
  containsIntrinsicText: boolean;
  containsText: boolean;
  id: string;
  kind: "shared-underlay" | "shared-overlay";
  nodePaths: string[];
  reason: string;
  region: SerializableRegion;
  relativePath?: string;
  svgPath?: string;
  textTreatment: string;
};

export type SvgVerticalModuleReport = {
  design: {
    height: number;
    name: string;
    svgPath: string;
    width: number;
  };
  diffRegions: SerializableRegion[];
  gaps: ModuleGap[];
  ignoredNodeCount: number;
  minGap: number;
  mode: ModulePlanningRoute;
  modules: SvgVerticalModule[];
  options: {
    minGap: number;
    planner?: ModulePlannerMode;
    plannerRetries?: number;
    requestedMode: ModulePlanMode;
    targetModuleCount: number | null;
  };
  planner?: ModulePlannerMetadata;
  regions: SerializableRegion[];
  sharedLayers: SvgSharedLayer[];
  sourceStats: {
    containerCount: number;
    ocrBlockCount: number;
    shellEntryCount: number;
    svgNodeCount: number;
  };
  strategy: string;
  textLayoutCoordinateSpace?: "absolute" | "local";
  warnings: string[];
};

export type SvgVerticalModuleArtifacts = {
  artifactDir: string;
  diffRegionsPath: string;
  jsonPath: string;
  markdownPath: string;
  moduleDir: string;
  qualityJsonPath: string;
  qualityMarkdownPath: string;
  qualityReport: ModulePlanQualityReport;
  regionsPath: string;
  report: SvgVerticalModuleReport;
};

export type CreateAdaptiveModulePlanOptions = {
  artifactDir?: string;
  concurrencyLimit?: number;
  containerLayoutReport?: ContainerLayoutReport;
  inputPath: string;
  minGap?: number;
  mode?: ModulePlanMode;
  ocrBlocks?: OcrBlocksInput;
  planner?: ModulePlannerMode;
  plannerRetries?: number;
  scale?: number;
  shellManifest?: ShellManifestInput;
  svgLayoutReport?: SvgLayoutResult;
};

export type PlannedModules = {
  gaps: ModuleGap[];
  ignoredNodeCount: number;
  modules: SvgVerticalModule[];
  sharedLayers: SvgSharedLayer[];
  strategy: string;
  warnings: string[];
};
