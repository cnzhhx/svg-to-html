import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { sessionStore } from "../../../session-store.js";
import type { readModulePlan } from "../../module-merge/index.js";
import type { VerifyResult } from "../../verify.js";
import type {
  ModuleAgentRunRecord,
  ModuleValidationRun,
} from "./module-pipeline-records.js";

type ModulePipelineV2Result = {
  failedModuleIds: string[];
  moduleFailureKinds: Record<string, string>;
  moduleAgentManifestPath: string;
  moduleAgentRuns: ModuleAgentRunRecord[];
  moduleValidationRuns: ModuleValidationRun[];
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  scaffoldHtmlPath: string;
  verifyResult: VerifyResult;
};

const resolveSessionRenderEntryPath = ({
  design,
  session,
}: {
  design: ResolvedDesignTarget;
  session?: ReturnType<typeof sessionStore.get>;
}) =>
  session?.result.renderEntryPath ??
  session?.outputTarget?.renderEntryPath ??
  design.outputTarget.renderEntryPath;

const normalizeModules = (
  modulePlan: Awaited<ReturnType<typeof readModulePlan>>,
) =>
  Array.isArray(modulePlan.modules)
    ? (modulePlan.modules as SvgVerticalModule[])
    : (Object.entries(modulePlan.modules ?? {}).map(([id, value]) => ({
        ...(typeof value === "object" && value ? value : {}),
        id,
      })) as SvgVerticalModule[]);

export { normalizeModules, resolveSessionRenderEntryPath };
export type { ModulePipelineV2Result };
