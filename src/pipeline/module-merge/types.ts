import type { OutputFormat, SessionOutputTarget } from "../../core/output-target.js";
import type { ComponentLibrarySessionRef } from "../../core/component-library/types.js";
import type { Region } from "../../core/geometry.js";
import type { ResolvedSvgDesign } from "../../core/design-resolve.js";
import type { ModuleOutputAllowedAsset } from "../module-output-policy.js";

type ModulePlanModule = {
  dir?: string;
  id: string;
  region?: Region;
  [key: string]: unknown;
};

type ModulePlanSharedLayer = {
  id: string;
  kind: "shared-underlay" | "shared-overlay";
  region?: Region;
  relativePath?: string;
  svgPath?: string;
  [key: string]: unknown;
};

type ModulePlan = {
  design?: {
    height?: number;
    name?: string;
    svgPath?: string;
    width?: number;
  };
  componentAdoptionPlanPath?: string;
  componentLibrary?: ComponentLibrarySessionRef;
  modules?: ModulePlanModule[] | Record<string, Omit<ModulePlanModule, "id">>;
  outputFormat?: OutputFormat;
  renderEntryPath?: string;
  scaffoldRenderPath?: string;
  sharedLayers?: ModulePlanSharedLayer[];
  sourceEntryPath?: string;
  [key: string]: unknown;
};

type ModuleFragmentManifest = {
  componentDecision?: {
    reason?: string;
    requiredCandidates?: Array<{
      componentName?: string;
      confidence?: number;
      semanticUnit?: string;
    }>;
    rejectedCandidates?: Array<
      | string
      | {
          category?:
            | "build-incompatible"
            | "no-public-api"
            | "policy-conflict"
            | "semantic-mismatch";
          componentName?: string;
          confidence?: number;
          importName?: string;
          name?: string;
          reason?: string;
          semanticUnit?: string;
          tag?: string;
        }
    >;
    used?: boolean;
  };
  id?: string;
  moduleId?: string;
  region?: Region;
  usedComponents?: Array<{
    importMode?: "default" | "named";
    importName?: string;
    importPath?: string;
    name?: string;
    tag?: string;
  }>;
  [key: string]: unknown;
};

/**
 * Per-module source-data payload written to `source-data.json` by the module
 * agent (Vue/React only). The merge pipeline exposes the whole object as a
 * page-scoped `sourceData` constant keyed by module id; source fragments
 * reference it as `sourceData["<moduleId>"].xxx`. The shape is otherwise free
 * (any JSON object literal).
 */
type ModuleSourceData = Record<string, unknown>;

type ModuleMergeOptions = {
  artifactDir?: string;
  design?: ResolvedSvgDesign;
  mergeSource?: boolean;
  modulePlanPath?: string;
  modulesDir?: string;
  outputTarget?: SessionOutputTarget;
  renderEntryPath?: string;
  scaffoldRenderPath?: string;
  skipInvalidModules?: boolean;
  sourceEntryPath?: string;
  sourceStylePath?: string;
  [key: string]: unknown;
};

type ModuleMergeSkippedModule = {
  error: string;
  id: string;
};

type ModuleMergeResolvedModule = {
  allowedAssets: ModuleOutputAllowedAsset[];
  dir: string;
  id: string;
  manifest: ModuleFragmentManifest;
  manifestPath: string;
  moduleLocalAssetRefs: string[];
  moduleCss: string;
  moduleCssPath: string;
  planEntry: ModulePlanModule;
  previewFragmentHtml: string;
  previewFragmentPath: string;
  region: Region;
  sourceFragment?: string;
  sourceFragmentPath?: string;
  sourceData?: ModuleSourceData;
  sourceDataPath?: string;
  sourceDataRaw?: string;
};

type ModuleMergeResult = {
  renderEntryPath: string;
  frameworkBuildDir?: string;
  moduleCount: number;
  moduleIds: string[];
  modulePlanPath: string;
  modulesDir: string;
  outputFormat?: OutputFormat;
  scaffoldRenderPath: string;
  skippedModuleIds: string[];
  skippedModules: ModuleMergeSkippedModule[];
  sourceEntryPath?: string;
  sourceStylePath?: string;
};

export type {
  ModuleFragmentManifest,
  ModuleMergeOptions,
  ModuleMergeResolvedModule,
  ModuleMergeResult,
  ModuleMergeSkippedModule,
  ModulePlan,
  ModulePlanModule,
  ModulePlanSharedLayer,
  ModuleSourceData,
};
