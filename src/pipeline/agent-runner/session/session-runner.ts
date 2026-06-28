import { existsSync } from "node:fs";
import path from "node:path";

import {
  getDiffRatioThreshold,
  withSessionRuntimeSettings,
} from "../../../config/index.js";
import { resolveDesignTarget } from "../../../core/design-resolve.js";
import { sessionStore, type SessionResult } from "../../../session-store.js";
import { withModelUsageContext } from "../../model-usage.js";
import { getMaxParallelModuleAgents } from "../../../config/index.js";
import {
  runModulePipelineV2,
  runModuleUserRevision,
} from "../module/module-pipeline-v2.js";
import { prepareStructuredSessionInputs } from "./preflight.js";
import { isAbortError, throwIfRunAborted } from "./run-control.js";
import { buildQualityAssessment } from "../verify/verify-gates.js";

import type { VerifyResult } from "../../verify.js";

type ModulePipelineResult = Awaited<ReturnType<typeof runModulePipelineV2>>;
type ModulePipelineResultBase = Omit<ModulePipelineResult, "verifyResult">;
type PendingUserInstruction = {
  moduleId?: string;
  text: string;
};

const resolveExistingModulePipelineBase = (
  result: SessionResult | undefined,
): ModulePipelineResultBase | null => {
  const modulePlanPath = result?.modulePlanPath;
  if (!modulePlanPath || !existsSync(modulePlanPath)) return null;

  const modulesRootDir = path.dirname(modulePlanPath);
  const scaffoldHtmlPath = path.join(modulesRootDir, "modules-scaffold.html");
  const moduleMergeManifestPath =
    result?.moduleMergeManifestPath ??
    path.join(modulesRootDir, "module-merge-manifest.json");
  if (!existsSync(scaffoldHtmlPath) || !existsSync(moduleMergeManifestPath)) {
    return null;
  }

  return {
    failedModuleIds: result?.moduleFailedIds ?? [],
    moduleFailureKinds: result?.moduleFailureKinds ?? {},
    moduleAgentManifestPath:
      result?.moduleAgentManifestPath ??
      path.join(modulesRootDir, "module-agent-manifest.json"),
    moduleAgentRuns: (result?.moduleAgentRuns ??
      []) as ModulePipelineResult["moduleAgentRuns"],
    moduleMergeManifestPath,
    modulePlanPath,
    moduleValidationRuns: (result?.moduleValidationRuns ??
      []) as ModulePipelineResult["moduleValidationRuns"],
    scaffoldHtmlPath,
  };
};

const runSelectedModuleRevisionPipeline = async ({
  artifactDir,
  controller,
  design,
  moduleId,
  pipelineBase,
  round,
  sessionId,
  userInstructions,
}: {
  artifactDir: string;
  controller: AbortController;
  design: Awaited<ReturnType<typeof resolveDesignTarget>>;
  moduleId: string;
  pipelineBase: ModulePipelineResultBase;
  round: number;
  sessionId: string;
  userInstructions: string;
}): Promise<ModulePipelineResult> => {
  const result = await runModuleUserRevision({
    artifactDir,
    controller,
    design,
    moduleId,
    moduleMergeManifestPath: pipelineBase.moduleMergeManifestPath,
    modulePlanPath: pipelineBase.modulePlanPath,
    round,
    scaffoldHtmlPath: pipelineBase.scaffoldHtmlPath,
    sessionId,
    userInstructions,
  });
  throwIfRunAborted(controller);
  return result;
};

const dequeueAllPendingUserMessages = (sessionId: string) => {
  const messages: PendingUserInstruction[] = [];
  for (;;) {
    const next = sessionStore.dequeuePendingMessage(sessionId);
    if (!next) break;
    messages.push(typeof next === "string" ? { text: next } : next);
  }
  return messages;
};

const runSession = (sessionId: string, controller: AbortController) =>
  withSessionRuntimeSettings(sessionId, () =>
    withModelUsageContext({ sessionId, source: "session" }, async () => {
      const session = sessionStore.get(sessionId);
      if (!session) return;

      sessionStore.markExecutionStarted(sessionId);
      sessionStore.setWorkflowMeta(sessionId, {
        detail: "任务已开始，准备执行统一模块流水线",
        iteration: 1,
        maxIterations: 1,
      });

  try {
    const pendingUserMessages = dequeueAllPendingUserMessages(sessionId);
    const userInstructions = pendingUserMessages
      .map((message, index) => `用户补充 ${index + 1}: ${message.text}`)
      .join("\n");
    const selectedModuleIds = [
      ...new Set(
        pendingUserMessages
          .map((message) => message.moduleId?.trim())
          .filter((moduleId): moduleId is string => Boolean(moduleId)),
      ),
    ];
    if (pendingUserMessages.length && selectedModuleIds.length !== 1) {
      throw new Error("聊天修复必须选择且只能选择一个模块");
    }
    const selectedModuleId = selectedModuleIds[0];
    const hasUserInstructions = Boolean(userInstructions.trim());
    if (pendingUserMessages.length) {
      sessionStore.addLog(
        sessionId,
        `[pipeline] consumed ${pendingUserMessages.length} pending user message(s) for this run`,
      );
    }

    throwIfRunAborted(controller);
    let design = await resolveDesignTarget(session.svgPath, {
      format: session.outputFormat,
      scale: session.scale ?? 1,
    });

    const preflightReady = Boolean(
      session.result.containerLayoutPath &&
      session.result.modulePlanPath,
    );

    if (!preflightReady) {
      const prepared = await prepareStructuredSessionInputs({
        artifactDir: session.artifactDir,
        controller,
        outputFormat: session.outputFormat,
        scale: design.scale,
        sessionId,
        svgPath: design.svgPath,
      });
      design = prepared.design;
    }
    throwIfRunAborted(controller);

    const currentAfterPreflight = sessionStore.get(sessionId);
    const moduleCount = Math.max(
      1,
      Number(currentAfterPreflight?.result.moduleCount ?? 1),
    );
    const maxParallelModuleAgents = getMaxParallelModuleAgents();
    if (currentAfterPreflight) {
      sessionStore.update(sessionId, {
        result: {
          ...currentAfterPreflight.result,
          moduleConcurrencyLimit: maxParallelModuleAgents,
          moduleCount,
          moduleCountExceedsConcurrency:
            moduleCount > maxParallelModuleAgents,
        },
      });
    }
    const existingPipelineBase = hasUserInstructions
      ? resolveExistingModulePipelineBase(currentAfterPreflight?.result)
      : null;
    const workflowDetail = existingPipelineBase
      ? `用户补充要求将由模块 ${selectedModuleId} agent 直接处理`
      : hasUserInstructions
        ? `用户补充要求将在模块合并后交给模块 ${selectedModuleId} agent`
        : moduleCount > maxParallelModuleAgents
          ? `统一模块流水线已启用：模块数 ${moduleCount} 超过并发 ${maxParallelModuleAgents}，会分批执行`
          : `统一模块流水线已启用：模块数 ${moduleCount}`;

    sessionStore.setWorkflowMeta(sessionId, {
      detail: workflowDetail,
      maxIterations: hasUserInstructions ? 2 : 1,
    });

    let pipelineResult = existingPipelineBase
      ? await runSelectedModuleRevisionPipeline({
          artifactDir: session.artifactDir,
          controller,
          design,
          moduleId: selectedModuleId!,
          pipelineBase: existingPipelineBase,
          round: 2,
          sessionId,
          userInstructions,
        })
      : await runModulePipelineV2({
          controller,
          design,
          maxParallelModuleAgents,
          sessionId,
        });

    if (hasUserInstructions && !existingPipelineBase) {
      pipelineResult = await runSelectedModuleRevisionPipeline({
        artifactDir: session.artifactDir,
        controller,
        design,
        moduleId: selectedModuleId!,
        pipelineBase: pipelineResult,
        round: 2,
        sessionId,
        userInstructions,
      });
    }
    throwIfRunAborted(controller);

    let verifyResult: VerifyResult = pipelineResult.verifyResult;
    let failedModuleIds = pipelineResult.failedModuleIds;

    const qualityAssessment = buildQualityAssessment(verifyResult, {
      diffRatioThreshold: getDiffRatioThreshold(),
    });
    const currentSessionBeforeComplete = sessionStore.get(sessionId);
    if (currentSessionBeforeComplete) {
      sessionStore.update(sessionId, {
        result: {
          ...currentSessionBeforeComplete.result,
          moduleAgentManifestPath: pipelineResult.moduleAgentManifestPath,
          moduleAgentRuns: pipelineResult.moduleAgentRuns,
          moduleFailedIds: failedModuleIds,
          moduleMergeManifestPath: pipelineResult.moduleMergeManifestPath,
          moduleValidationRuns: pipelineResult.moduleValidationRuns,
          diffRatio: verifyResult.diffRatio,
        },
      });
    }

    sessionStore.addLog(
      sessionId,
      `[pipeline] complete: quality=${qualityAssessment.status}, final diffRatio=${(verifyResult.diffRatio * 100).toFixed(2)}%${qualityAssessment.softIssues.length ? `, notes=${qualityAssessment.softIssues.join("; ")}` : ""}`,
    );
    sessionStore.addLog(sessionId, "[pipeline] artifacts ready");
    const completionDetail = "执行完成";
    sessionStore.completePipeline(sessionId, {
      detail: completionDetail,
      status: "completed",
    });
  } catch (error) {
    if (isAbortError(error) && controller.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const current = sessionStore.get(sessionId);
    const currentStep = current?.activeStep;
    if (currentStep) sessionStore.failStep(sessionId, currentStep, message);
    if (current?.progress?.currentNode) {
      sessionStore.failWorkflowNode(
        sessionId,
        current.progress.currentNode,
        message,
      );
    }
    sessionStore.failPipeline(sessionId, message);
      }
    }),
  );

export { runSession };
