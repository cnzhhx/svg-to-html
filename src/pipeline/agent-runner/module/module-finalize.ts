import { getModuleDiffRatioThreshold } from "../../../config/index.js";
import type { OutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { sessionStore } from "../../../session-store.js";
import { mergeModulesIntoHtml } from "../../module-merge/index.js";
import type { ModulePlan } from "../../module-merge/types.js";
import type { VerifyResult } from "../../verify.js";
import { runWithLimit } from "../queue/concurrency.js";
import { throwIfRunAborted } from "../session/run-control.js";
import { runVerify } from "../verify/verify-step.js";
import { checkFrameworkRenderHealth } from "../verify/render-health-check.js";
import {
  getModuleDir,
  hasCompleteModuleOutput,
  restoreHostModuleArtifacts,
} from "./module-artifacts.js";
import {
  type ModuleAgentRunRecord,
  type ModuleValidationFailureKind,
  type ModuleValidationRun,
} from "./module-pipeline-records.js";
import { readPersistedModuleAgentThreadIds } from "./module-thread-ids.js";

type PublishMergeReadinessInput = {
  mergeResult: Awaited<ReturnType<typeof mergeModulesIntoHtml>>;
  moduleMergeManifestPath: string;
  sessionId: string;
};

type ModulePipelineFinalizationInput = {
  artifactDir: string;
  controller: AbortController;
  design: ResolvedDesignTarget;
  failedModuleKinds: Map<string, ModuleValidationFailureKind>;
  failedModules: Map<string, string>;
  maxParallelModuleAgents: number;
  moduleAgentManifestPath: string;
  moduleAgentRuns: ModuleAgentRunRecord[];
  moduleMergeManifestPath: string;
  modulePlan: ModulePlan;
  modulePlanPath: string;
  moduleValidationRuns: ModuleValidationRun[];
  modules: SvgVerticalModule[];
  modulesRootDir: string;
  outputFormat: OutputFormat;
  renderEntryPath: string;
  scaffoldHtmlPath: string;
  sessionId: string;
};

type ModulePipelineFinalizationResult = {
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

const publishMergeReadiness = async ({
  mergeResult,
  moduleMergeManifestPath,
  sessionId,
}: PublishMergeReadinessInput) => {
  const latestSession = sessionStore.get(sessionId);
  if (!latestSession) return;

  sessionStore.update(sessionId, {
    result: {
      ...latestSession.result,
      moduleMergeManifestPath,
      renderEntryPath: mergeResult.renderEntryPath,
      sourceEntryPath:
        mergeResult.sourceEntryPath ?? latestSession.result.sourceEntryPath,
      sourceStylePath:
        mergeResult.sourceStylePath ?? latestSession.result.sourceStylePath,
    },
  });
};

const runModulePipelineFinalization = async ({
  artifactDir,
  controller,
  design,
  failedModuleKinds,
  failedModules,
  maxParallelModuleAgents,
  moduleAgentManifestPath,
  moduleAgentRuns,
  moduleMergeManifestPath,
  modulePlan,
  modulePlanPath,
  moduleValidationRuns,
  modules,
  modulesRootDir,
  outputFormat,
  renderEntryPath,
  scaffoldHtmlPath,
  sessionId,
}: ModulePipelineFinalizationInput): Promise<ModulePipelineFinalizationResult> => {
  sessionStore.addLog(
    sessionId,
    "[module-pipeline-v2] using latest module artifacts without snapshot restore",
  );

  await restoreHostModuleArtifacts({
    modules,
    modulesRootDir,
  });
  throwIfRunAborted(controller);
  sessionStore.addLog(
    sessionId,
    "[module-pipeline-v2] validating latest module artifacts",
  );
  await runWithLimit({
    items: modules,
    limit: maxParallelModuleAgents,
    signal: controller.signal,
    worker: async (module) => {
      throwIfRunAborted(controller);
      const moduleDir = getModuleDir(modulesRootDir, module);
      const preserveExistingInputFailure =
        failedModuleKinds.get(module.id) === "module_input_failed";
      if (!hasCompleteModuleOutput(moduleDir, outputFormat)) {
        const message = "incomplete module output before final merge";
        if (!preserveExistingInputFailure) {
          failedModules.set(module.id, message);
          failedModuleKinds.set(module.id, "incomplete_output");
        }
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] latest artifact preflight failed: ${message}`,
        );
        return;
      }

      if (failedModuleKinds.get(module.id) !== "module_input_failed") {
        failedModules.delete(module.id);
        failedModuleKinds.delete(module.id);
      }
    },
  });
  throwIfRunAborted(controller);
  const finalMergeResult = await mergeModulesIntoHtml({
    design,
    modulePlanPath,
    outputTarget: design.outputTarget,
    renderEntryPath,
    skipInvalidModules: true,
    scaffoldRenderPath: scaffoldHtmlPath,
  });
  finalMergeResult.skippedModules.forEach((skipped) => {
    failedModules.set(skipped.id, skipped.error);
    failedModuleKinds.set(skipped.id, "merge_failed");
  });
  await writeJsonFile(moduleMergeManifestPath, finalMergeResult);
  await publishMergeReadiness({
    mergeResult: finalMergeResult,
    moduleMergeManifestPath,
    sessionId,
  });
  throwIfRunAborted(controller);

  const finalVerifyResult = await runVerify(
    sessionId,
    design.svgPath,
    artifactDir,
    2,
    true,
    { mode: "full", signal: controller.signal },
  );
  throwIfRunAborted(controller);
  moduleValidationRuns.push({
    diffRatio: finalVerifyResult.diffRatio,
    failedModuleIds: [...failedModules.keys()].sort(),
    moduleStats: [],
    round: 2,
    scope: "merged-page",
    threshold: getModuleDiffRatioThreshold(),
  });

  // Framework pages can compile yet render blank if the bundle throws at mount.
  if (outputFormat !== "html") {
    const designWidth =
      design.width ?? modulePlan.design?.width;
    const designHeight =
      design.height ?? modulePlan.design?.height;
    if (designWidth === undefined || designHeight === undefined) {
      throw new Error(
        "framework render health check failed: missing design viewport size",
      );
    }
    const health = await checkFrameworkRenderHealth({
      artifactDir,
      viewportHeight: designHeight,
      viewportWidth: designWidth,
    });
    throwIfRunAborted(controller);
    if (!health.ok) {
      const message = `framework render health check failed: ${health.reason ?? "mount point empty"}`;
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2] ${message}`,
      );
      throw new Error(message);
    }
    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2] framework render health check passed (mount point populated)`,
    );
  }
  const completedAgentLocalRounds = moduleValidationRuns.filter(
    (run) => run.scope === "agent-local",
  ).length;
  await writeJsonFile(moduleAgentManifestPath, {
    concurrency: maxParallelModuleAgents,
    moduleCount: modules.length,
    threadIds: readPersistedModuleAgentThreadIds(sessionId),
    runs: moduleAgentRuns,
    validation: {
      failedModuleIds: [...failedModules.keys()].sort(),
      failedModuleKinds: Object.fromEntries(failedModuleKinds),
      maxIterations: 1,
      rounds: completedAgentLocalRounds,
      threshold: getModuleDiffRatioThreshold(),
    },
    validationRuns: moduleValidationRuns,
  });

  const latestSession = sessionStore.get(sessionId);
  if (latestSession) {
    sessionStore.update(sessionId, {
      result: {
        ...latestSession.result,
        moduleAgentManifestPath,
        moduleAgentRuns,
        moduleAgentThreadIds: readPersistedModuleAgentThreadIds(sessionId),
        moduleFailedIds: [...failedModules.keys()].sort(),
        moduleFailureKinds: Object.fromEntries(failedModuleKinds),
        moduleFailures: Object.fromEntries(failedModules),
        moduleMergeManifestPath,
        moduleValidationRuns,
      },
    });
  }

  const failedModuleIds = [...failedModules.keys()].sort();
  if (failedModuleIds.length) {
    throw new Error(
      `Module agent pipeline failed for ${failedModuleIds.length}/${modules.length} module(s): ${failedModuleIds.join(", ")}`,
    );
  }

  return {
    failedModuleIds,
    moduleFailureKinds: Object.fromEntries(failedModuleKinds),
    moduleAgentManifestPath,
    moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath,
    modulePlanPath,
    scaffoldHtmlPath,
    verifyResult: finalVerifyResult,
  };
};

export { publishMergeReadiness, runModulePipelineFinalization };
