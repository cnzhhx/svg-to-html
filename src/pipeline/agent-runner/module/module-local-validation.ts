import path from "node:path";

import { getModuleDiffRatioThreshold } from "../../../config/index.js";
import type { OutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { sessionStore } from "../../../session-store.js";
import { mergeModulesIntoHtml } from "../../module-merge/index.js";
import type { ModulePlan } from "../../module-merge/types.js";
import { runWithLimit } from "../queue/concurrency.js";
import { throwIfRunAborted } from "../session/run-control.js";
import {
  ensureModuleSvg,
  getModuleDir,
  hasCompleteModuleOutput,
  readModuleSnapshot,
  restoreHostModuleArtifacts,
  type ModuleSnapshot,
} from "./module-artifacts.js";
import {
  type ModuleValidationFailureKind,
  type ModuleValidationRun,
  type ModuleValidationStat,
} from "./module-pipeline-records.js";
import { verifyModuleFrameworkLocal } from "./module-framework-local-verify.js";
import { verifyModuleLocal } from "./module-local-verify.js";

type CollectAgentLocalValidationInput = {
  bestSnapshots: Map<string, ModuleSnapshot>;
  controller: AbortController;
  design: ResolvedDesignTarget;
  failedModuleKinds: Map<string, ModuleValidationFailureKind>;
  failedModules: Map<string, string>;
  maxParallelModuleAgents: number;
  modulePlan: ModulePlan;
  modulePlanPath: string;
  moduleValidationRuns: ModuleValidationRun[];
  modules: SvgVerticalModule[];
  modulesRootDir: string;
  outputFormat: OutputFormat;
  scaffoldHtmlPath: string;
  sessionId: string;
};

const collectAgentLocalValidation = async ({
  bestSnapshots,
  controller,
  design,
  failedModuleKinds,
  failedModules,
  maxParallelModuleAgents,
  modulePlan,
  modulePlanPath,
  moduleValidationRuns,
  modules,
  modulesRootDir,
  outputFormat,
  scaffoldHtmlPath,
  sessionId,
}: CollectAgentLocalValidationInput) => {
  sessionStore.startWorkflowNode(sessionId, "verify", {
    detail: `正在收集模块局部 diff 结果：${modules.length} 个模块`,
    iteration: 1,
    maxIterations: 1,
  });
  sessionStore.startStep(sessionId, "verify");
  sessionStore.addLog(
    sessionId,
    `[module-pipeline-v2] collect agent local module diff for ${modules.length} module(s)`,
  );

  const candidateSnapshots = new Map<string, ModuleSnapshot>();
  const validatedStats = await runWithLimit({
    items: modules,
    limit: maxParallelModuleAgents,
    signal: controller.signal,
    worker: async (module) => {
      const moduleDir = getModuleDir(modulesRootDir, module);
      throwIfRunAborted(controller);
      const moduleSvgPath = await ensureModuleSvg({
        design,
        module,
        modulesRootDir,
      });
      let mergeError: string | undefined;
      let failureKind: ModuleValidationFailureKind | undefined;
      const hasOutput = hasCompleteModuleOutput(moduleDir, outputFormat);
      let localVerify = null as Awaited<
        ReturnType<typeof verifyModuleLocal>
      > | null;
      if (!hasOutput) {
        failureKind = "incomplete_output";
      }

      if (hasOutput) {
        try {
          localVerify = await verifyModuleLocal({
            module,
            moduleDir,
            modulePlan,
            modulePlanPath,
            moduleSvgPath,
            onProgress: (message) =>
              sessionStore.addLog(
                sessionId,
                `[module-pipeline-v2:${module.id}] local verify: ${message}`,
              ),
            round: 1,
            scale: design.scale,
            scaffoldHtmlPath,
            signal: controller.signal,
          });
        } catch (error) {
          mergeError = error instanceof Error ? error.message : String(error);
          failureKind = "merge_failed";
          failedModules.set(module.id, mergeError);
          failedModuleKinds.set(module.id, failureKind);
        }
      }

      let frameworkVerifyDiffRatio: number | undefined;
      if (!mergeError && hasOutput && outputFormat !== "html") {
        try {
          const frameworkResult = await verifyModuleFrameworkLocal({
            design,
            module,
            moduleDir,
            moduleSvgPath,
            onProgress: (message) =>
              sessionStore.addLog(
                sessionId,
                `[module-pipeline-v2:${module.id}] framework verify: ${message}`,
              ),
            round: 1,
            signal: controller.signal,
          });
          if (frameworkResult) {
            if (frameworkResult.buildError) {
              mergeError = `build-incompatible: ${frameworkResult.buildError}`;
              failureKind = "module_framework_failed";
              failedModules.set(module.id, mergeError);
              failedModuleKinds.set(module.id, failureKind);
            } else {
              frameworkVerifyDiffRatio = frameworkResult.diffRatio;
              sessionStore.addLog(
                sessionId,
                `[module-pipeline-v2:${module.id}] framework local diffRatio=${(frameworkResult.diffRatio * 100).toFixed(2)}%`,
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mergeError = message;
          failureKind = "module_framework_failed";
          failedModules.set(module.id, mergeError);
          failedModuleKinds.set(module.id, failureKind);
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] framework verify error: ${message}`,
          );
        }
      }

      const previewDiffRatio = localVerify?.diffRatio ?? 1;
      const diffRatio =
        frameworkVerifyDiffRatio !== undefined
          ? Math.max(previewDiffRatio, frameworkVerifyDiffRatio)
          : previewDiffRatio;
      const passed =
        !mergeError &&
        hasOutput &&
        Boolean(localVerify) &&
        diffRatio <= getModuleDiffRatioThreshold();
      if (!passed && !failureKind) {
        failureKind = "module_visual_failed";
      }

      if (!mergeError && hasOutput && localVerify) {
        candidateSnapshots.set(
          module.id,
          await readModuleSnapshot(moduleDir, diffRatio, outputFormat),
        );
      }

      if (!hasOutput) {
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] incomplete module output`,
        );
      } else if (mergeError) {
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] local verify failed: ${mergeError}`,
        );
      } else if (!localVerify) {
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] no module-local verify result`,
        );
      } else {
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] module-local diffRatio=${(diffRatio * 100).toFixed(2)}%`,
        );
      }

      return {
        diffPixels: localVerify?.diffPixels,
        diffRatio,
        failureKind,
        id: module.id,
        mergeError,
        passed,
        renderPngPath: localVerify?.renderPngPath,
      };
    },
  });

  await restoreHostModuleArtifacts({
    modules,
    modulesRootDir,
  });
  throwIfRunAborted(controller);
  const draftHtmlPath = path.join(
    modulesRootDir,
    "draft-round-1.html",
  );
  const draftMergeResult = await mergeModulesIntoHtml({
    mergeSource: false,
    modulePlanPath,
    renderEntryPath: draftHtmlPath,
    skipInvalidModules: true,
    scaffoldRenderPath: scaffoldHtmlPath,
  });
  const statsById = new Map<string, ModuleValidationStat>(
    validatedStats.map((stat) => [stat.id, stat]),
  );
  draftMergeResult.skippedModules.forEach((skipped) => {
    const stat =
      statsById.get(skipped.id) ??
      ({
        diffRatio: 1,
        id: skipped.id,
        passed: false,
      } satisfies ModuleValidationStat);
    const failureKind = "merge_failed";
    failedModules.set(skipped.id, skipped.error);
    failedModuleKinds.set(skipped.id, failureKind);
    stat.mergeError = skipped.error;
    stat.failureKind = failureKind;
    stat.passed = false;
    statsById.set(skipped.id, stat);
  });
  const moduleStats = modules.map((module) => {
    const existing =
      statsById.get(module.id);
    if (existing) {
      const mergeError = failedModules.get(module.id);
      const failureKind =
        failedModuleKinds.get(module.id) ?? existing.failureKind;
      return mergeError
        ? { ...existing, failureKind, mergeError, passed: false }
        : { ...existing };
    }
    return {
      diffRatio: 1,
      failureKind:
        failedModuleKinds.get(module.id) ?? "module_visual_failed",
      id: module.id,
      mergeError:
        failedModules.get(module.id) ??
        "module was not validated in this run",
      passed: false,
    } satisfies ModuleValidationStat;
  });
  for (const [moduleId, snapshot] of candidateSnapshots) {
    const stat = moduleStats.find((candidate) => candidate.id === moduleId);
    if (!stat || stat.mergeError || failedModules.has(moduleId)) continue;
    const best = bestSnapshots.get(moduleId);
    if (!best || snapshot.diffRatio < best.diffRatio) {
      bestSnapshots.set(moduleId, snapshot);
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2:${moduleId}] best mergeable agent-local snapshot: ${(snapshot.diffRatio * 100).toFixed(2)}%`,
      );
    }
  }

  // 清除已通过当前轮次验证的模块的旧错误
  modules.forEach((module) => {
    const stat = moduleStats.find((candidate) => candidate.id === module.id);
    if (stat?.passed && !stat.mergeError) {
      failedModules.delete(module.id);
      failedModuleKinds.delete(module.id);
    }
  });

  const failedModuleIds = modules.flatMap((module) => {
    const stat = moduleStats.find((candidate) => candidate.id === module.id);
    if (stat?.passed && !failedModules.has(module.id)) return [];

    const failureKind =
      failedModuleKinds.get(module.id) ?? stat?.failureKind;
    if (failureKind === "module_input_failed") return [];

    return [module.id];
  });
  const maxDiffRatio = moduleStats.reduce(
    (max, stat) => Math.max(max, stat.diffRatio),
    0,
  );

  moduleValidationRuns.push({
    draftHtmlPath,
    diffRatio: maxDiffRatio,
    failedModuleIds,
    moduleStats,
    round: 1,
    scope: "agent-local",
    threshold: getModuleDiffRatioThreshold(),
  });
  sessionStore.completeWorkflowNode(
    sessionId,
    "verify",
    `模块局部 diff 结果已收集，失败 ${failedModuleIds.length} 个模块`,
  );
  sessionStore.completeStep(sessionId, "verify", {
    moduleValidationRuns,
  });

  return { failedModuleIds };
};

export { collectAgentLocalValidation };
