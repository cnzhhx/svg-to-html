import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { AGENT_REASONING_EFFORTS } from "../../../config/agent-reasoning.js";
import { getModuleDiffRatioThreshold } from "../../../config/index.js";
import { normalizeOutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import { sessionStore } from "../../../session-store.js";
import {
  buildUserModuleGuidancePrompt,
  buildUserModuleRevisionPrompt,
} from "../../../prompts/module-agent.js";
import { readModulePlan, mergeModulesIntoHtml } from "../../module-merge/index.js";
import { finalizeModuleManifest } from "../../module-merge/finalize-module-manifest.js";
import { archiveSessionCheckpoint } from "../archive/checkpoint.js";
import { throwIfRunAborted } from "../session/run-control.js";
import { runVerify } from "../verify/verify-step.js";
import {
  createAgentUnitThread,
  runAgentUnit,
  setModuleActive,
} from "./agent-unit.js";
import { readModuleSemanticDocument } from "./module-semantic.js";
import {
  ensureModuleSvg,
  getModuleDir,
  hasCompleteModuleOutput,
  restoreHostModuleArtifacts,
} from "./module-artifacts.js";
import {
  getCachedInputTokens,
  getUncachedInputTokens,
  normalizeModuleFailureKind,
  type ModuleAgentRunRecord,
  type ModuleValidationFailureKind,
  type ModuleValidationRun,
} from "./module-pipeline-records.js";
import {
  normalizeModules,
  resolveSessionRenderEntryPath,
  type ModulePipelineV2Result,
} from "./module-pipeline-shared.js";
import {
  readAgentGeneratedAssetCount,
} from "./module-semantic-preprocess.js";
import {
  persistModuleAgentThreadId,
  readPersistedModuleAgentThreadIds,
} from "./module-thread-ids.js";
import { publishMergeReadiness } from "./module-finalize.js";
import {
  publishLivePreview,
  requestLivePreviewRefresh,
} from "./live-preview.js";

type ModuleUserRevisionInput = {
  artifactDir: string;
  controller: AbortController;
  design: ResolvedDesignTarget;
  moduleId: string;
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  moduleTurnInterrupts?: Map<string, AbortController>;
  promptMode?: "guidance" | "revision";
  publishFinalMerge?: boolean;
  round: number;
  scaffoldHtmlPath: string;
  sessionId: string;
  userInstructions: string;
};

type ModuleUserRevisionTurnInput = ModuleUserRevisionInput;

type ModuleUserRevisionTurnResult = {
  failedModuleIds: string[];
  moduleAgentManifestPath: string;
  moduleAgentRuns: ModuleAgentRunRecord[];
  moduleFailureKinds: Record<string, string>;
  moduleFailures: Record<string, string>;
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  moduleValidationRuns: ModuleValidationRun[];
  scaffoldHtmlPath: string;
};

async function runModuleUserRevisionTurn(
  input: ModuleUserRevisionTurnInput,
): Promise<ModuleUserRevisionTurnResult> {
  const {
    artifactDir,
    controller,
    design,
    moduleId,
    moduleMergeManifestPath,
    modulePlanPath,
    moduleTurnInterrupts,
    promptMode = "revision",
    publishFinalMerge = true,
    round,
    scaffoldHtmlPath,
    sessionId,
    userInstructions,
  } = input;

  let modulePlan = await readModulePlan(modulePlanPath);
  throwIfRunAborted(controller);
  const currentSession = sessionStore.get(sessionId);
  const outputFormat = normalizeOutputFormat(
    currentSession?.outputFormat ?? modulePlan.outputFormat,
  );
  const renderEntryPath = resolveSessionRenderEntryPath({
    design,
    session: currentSession,
  });
  if (!renderEntryPath) {
    throw new Error("Render entry path not available");
  }
  const modulesRootDir = path.dirname(modulePlanPath);
  const nextModulePlan = {
    ...modulePlan,
    outputFormat,
    renderEntryPath,
    scaffoldRenderPath: scaffoldHtmlPath,
    sourceEntryPath:
      currentSession?.result.sourceEntryPath ??
      currentSession?.outputTarget?.sourceEntryPath,
  };
  if (
    modulePlan.outputFormat !== nextModulePlan.outputFormat ||
    modulePlan.renderEntryPath !== nextModulePlan.renderEntryPath ||
    modulePlan.scaffoldRenderPath !== nextModulePlan.scaffoldRenderPath ||
    modulePlan.sourceEntryPath !== nextModulePlan.sourceEntryPath
  ) {
    modulePlan = nextModulePlan;
    await writeJsonFile(modulePlanPath, modulePlan);
  }
  const modules = normalizeModules(modulePlan);
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new Error(`模块不存在：${moduleId}`);
  }

  const moduleAgentManifestPath = path.join(
    modulesRootDir,
    "module-agent-manifest.json",
  );
  const moduleDir = getModuleDir(modulesRootDir, module);
  const moduleSemanticJsonPath = path.join(moduleDir, "module-semantic.json");
  const persistedModuleThreadIds = readPersistedModuleAgentThreadIds(sessionId);
  await mkdir(moduleDir, { recursive: true });
  throwIfRunAborted(controller);

  sessionStore.startWorkflowNode(sessionId, "agent", {
    detail: "正在处理聊天调整",
    iteration: round,
    maxIterations: round,
  });
  sessionStore.startStep(sessionId, "agent");
  sessionStore.addLog(
    sessionId,
    `[module-user-revision:${module.id}] starting user-selected module turn`,
  );

  const moduleSvgPath = await ensureModuleSvg({
    design,
    module,
    modulesRootDir,
  });
  throwIfRunAborted(controller);
  const moduleSemantic = await readModuleSemanticDocument(moduleDir);
  if (!moduleSemantic) {
    throw new Error(`module semantic not available for user revision: ${module.id}`);
  }
  sessionStore.addLog(
    sessionId,
    `[module-user-revision:${module.id}] reusing existing module semantic for fast user revision`,
  );
  throwIfRunAborted(controller);

  const thread = createAgentUnitThread({
    artifactDir,
    design,
    originalSvgPath: design.svgPath,
    reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
    threadId: persistedModuleThreadIds[module.id],
    workingDir: moduleDir,
  });
  const revisionPrompt =
    promptMode === "guidance"
      ? buildUserModuleGuidancePrompt({
          module,
          userInstructions,
        })
      : buildUserModuleRevisionPrompt({
          module,
          outputFormat,
          userInstructions,
        });
  const revisionPath = path.join(moduleDir, `revision-round-${round}.md`);
  const revisionLabel =
    promptMode === "guidance" ? "Module User Guidance" : "Module User Revision";
  await writeFile(revisionPath, revisionPrompt, "utf8");
  await archiveSessionCheckpoint({
    sessionId,
    round,
    stage: "agent",
    note: `${revisionLabel} ${module.id} round ${round}`,
    materials: [
      {
        kind: "file" as const,
        label: revisionLabel,
        sourcePath: revisionPath,
      },
    ],
  });

  const moduleTurnInterrupt = new AbortController();
  moduleTurnInterrupts?.set(module.id, moduleTurnInterrupt);
  let result: Awaited<ReturnType<typeof runAgentUnit>>;
  try {
    result = await runAgentUnit({
      module,
      moduleSvgPath,
      originalSvgPath: design.svgPath,
      design,
      workingDir: moduleDir,
      artifactDir,
      modulePlan,
      reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
      sessionId,
      controller,
      interruptSignal: moduleTurnInterrupt.signal,
      interruptLabel: "user-guidance-interrupt",
      prependFollowupBasePrompt: promptMode !== "guidance",
      revisionPrompt,
      onThreadStarted: (threadId) => {
        persistedModuleThreadIds[module.id] = threadId;
        persistModuleAgentThreadId({
          moduleId: module.id,
          sessionId,
          threadId,
        });
      },
      onArtifactUpdateSignal: () => {
        requestLivePreviewRefresh({
          design,
          modulePlanPath,
          scaffoldHtmlPath,
          sessionId,
        });
      },
      round,
      thread,
    });
  } catch (error) {
    setModuleActive({ active: false, moduleId: module.id, sessionId });
    throw error;
  } finally {
    if (moduleTurnInterrupts?.get(module.id) === moduleTurnInterrupt) {
      moduleTurnInterrupts.delete(module.id);
    }
  }
  if (result.interrupted) {
    sessionStore.addMessage(sessionId, {
      id: `system-${Date.now()}-${module.id}-guided-revision`,
      kind: "event",
      moduleId: module.id,
      role: "system",
      text: `已引导 ${module.id}，正在按新的用户要求继续。`,
    });
    const previousSession = sessionStore.get(sessionId);
    const previousRuns = Array.isArray(previousSession?.result.moduleAgentRuns)
      ? (previousSession.result.moduleAgentRuns as ModuleAgentRunRecord[])
      : [];
    const moduleAgentRuns: ModuleAgentRunRecord[] = [
      ...previousRuns,
      {
        cachedInputTokens: getCachedInputTokens(result.usage),
        durationMs: result.durationMs,
        endedAt: result.endedAt,
        error: result.interruptReason ?? "user guidance interrupted this turn",
        id: module.id,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputPaths: {
          ...result.outputPaths,
          moduleSemanticJson: moduleSemanticJsonPath,
        },
        outputTokens: result.usage?.output_tokens ?? 0,
        promptKind: "revision",
        region: module.region,
        round,
        startedAt: result.startedAt,
        status: "interrupted",
        threadId: result.threadId,
        turnSummary: result.turnSummary,
        uncachedInputTokens: getUncachedInputTokens(result.usage),
      },
    ];
    if (previousSession) {
      sessionStore.update(sessionId, {
        result: {
          ...previousSession.result,
          moduleActiveIds: (
            previousSession.result.moduleActiveIds ?? []
          ).filter((id) => id !== module.id),
          moduleAgentRuns,
        },
      });
    } else {
      setModuleActive({ active: false, moduleId: module.id, sessionId });
    }
    return {
      failedModuleIds: previousSession?.result.moduleFailedIds ?? [],
      moduleAgentManifestPath,
      moduleAgentRuns,
      moduleFailureKinds:
        previousSession?.result.moduleFailureKinds &&
        typeof previousSession.result.moduleFailureKinds === "object"
          ? (previousSession.result.moduleFailureKinds as Record<string, string>)
          : {},
      moduleFailures:
        previousSession?.result.moduleFailures &&
        typeof previousSession.result.moduleFailures === "object"
          ? (previousSession.result.moduleFailures as Record<string, string>)
          : {},
      moduleMergeManifestPath,
      modulePlanPath,
      moduleValidationRuns: (previousSession?.result.moduleValidationRuns ??
        []) as ModuleValidationRun[],
      scaffoldHtmlPath,
    };
  }
  const agentGeneratedAssetCount =
    await readAgentGeneratedAssetCount(moduleDir);
  try {
    await finalizeModuleManifest({ moduleDir });
  } catch (finalizeError) {
    sessionStore.addLog(
      sessionId,
      `[module-user-revision:${module.id}] finalize manifest warning: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
    );
  }

  const previousSession = sessionStore.get(sessionId);
  const previousRuns = Array.isArray(previousSession?.result.moduleAgentRuns)
    ? (previousSession.result.moduleAgentRuns as ModuleAgentRunRecord[])
    : [];
  const moduleAgentRuns: ModuleAgentRunRecord[] = [
    ...previousRuns,
    {
      cachedInputTokens: getCachedInputTokens(result.usage),
      durationMs: result.durationMs,
      endedAt: result.endedAt,
      finalDiffRatio: result.finalDiffRatio,
      id: module.id,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputByteSizes: result.outputByteSizes,
      agentGeneratedAssetCount,
      outputPaths: {
        ...result.outputPaths,
        moduleSemanticJson: moduleSemanticJsonPath,
      },
      outputTokens: result.usage?.output_tokens ?? 0,
      promptKind: "revision",
      region: module.region,
      round,
      startedAt: result.startedAt,
      status: result.success ? "completed" : "failed",
      threadId: result.threadId,
      turnSummary: result.turnSummary,
      uncachedInputTokens: getUncachedInputTokens(result.usage),
    },
  ];

  sessionStore.completeStep(sessionId, "agent");
  sessionStore.completeWorkflowNode(
    sessionId,
    "agent",
    `模块 ${module.id} 用户修复已完成，准备合并校验`,
  );
  throwIfRunAborted(controller);

  await restoreHostModuleArtifacts({
    modules,
    modulesRootDir,
  });
  throwIfRunAborted(controller);
  let selectedModuleOutputError: string | undefined;
  let selectedModuleOutputFailureKind: ModuleValidationFailureKind | undefined;
  if (!hasCompleteModuleOutput(moduleDir, outputFormat)) {
    selectedModuleOutputError = "incomplete module output";
    selectedModuleOutputFailureKind = "incomplete_output";
    sessionStore.addLog(
      sessionId,
      `[module-user-revision:${module.id}] incomplete module output after user revision`,
    );
  }
  let mergeSkippedModuleIds: string[] = [];
  let mergeSkippedModules: Array<{ error: string; id: string }> = [];
  if (publishFinalMerge) {
    const mergeResult = await mergeModulesIntoHtml({
      design,
      modulePlanPath,
      outputTarget: design.outputTarget,
      renderEntryPath,
      scaffoldRenderPath: scaffoldHtmlPath,
      skipInvalidModules: true,
    });
    mergeSkippedModuleIds = mergeResult.skippedModuleIds;
    mergeSkippedModules = mergeResult.skippedModules;
    await writeJsonFile(moduleMergeManifestPath, mergeResult);
    await publishMergeReadiness({
      mergeResult,
      moduleMergeManifestPath,
      sessionId,
    });
  }
  await publishLivePreview({
    design,
    modulePlanPath,
    scaffoldHtmlPath,
    sessionId,
  });
  throwIfRunAborted(controller);

  const previousModuleFailures =
    previousSession?.result.moduleFailures &&
    typeof previousSession.result.moduleFailures === "object"
      ? previousSession.result.moduleFailures
      : {};
  const mergedModuleFailures = new Map<string, string>(
    Object.entries(previousModuleFailures).filter(([id]) => id !== module.id),
  );
  const previousModuleFailureKinds =
    previousSession?.result.moduleFailureKinds &&
    typeof previousSession.result.moduleFailureKinds === "object"
      ? previousSession.result.moduleFailureKinds
      : {};
  const mergedModuleFailureKinds = new Map<string, ModuleValidationFailureKind>(
    Object.entries(previousModuleFailureKinds)
      .filter(([id]) => id !== module.id)
      .map(([id, kind]) => [id, normalizeModuleFailureKind(kind)]),
  );
  if (selectedModuleOutputError) {
    mergedModuleFailures.set(module.id, selectedModuleOutputError);
    mergedModuleFailureKinds.set(
      module.id,
      selectedModuleOutputFailureKind ?? "merge_failed",
    );
  }
  mergeSkippedModules.forEach((skipped) => {
    mergedModuleFailures.set(skipped.id, skipped.error);
    mergedModuleFailureKinds.set(
      skipped.id,
      "merge_failed",
    );
  });
  const failedModuleIds = [
    ...new Set([
      ...(previousSession?.result.moduleFailedIds ?? []).filter(
        (id) => id !== module.id,
      ),
      ...(selectedModuleOutputError ? [module.id] : []),
      ...mergeSkippedModuleIds,
    ]),
  ].sort();
  const moduleFailureKinds = Object.fromEntries(
    failedModuleIds.map((id) => [
      id,
      mergedModuleFailureKinds.get(id) ?? "merge_failed",
    ]),
  );
  const moduleFailures = Object.fromEntries(
    failedModuleIds.map((id) => [
      id,
      mergedModuleFailures.get(id) ?? "Module failed in a previous run",
    ]),
  );

  const moduleValidationRuns = [
    ...((previousSession?.result.moduleValidationRuns ??
      []) as ModuleValidationRun[]),
  ];
  await writeJsonFile(moduleAgentManifestPath, {
    moduleCount: modules.length,
    runs: moduleAgentRuns,
    threadIds: readPersistedModuleAgentThreadIds(sessionId),
    userRevision: {
      moduleId: module.id,
      round,
    },
    validation: {
      failedModuleIds,
      failedModuleKinds: moduleFailureKinds,
      maxIterations: round,
      threshold: getModuleDiffRatioThreshold(),
    },
    validationRuns: moduleValidationRuns,
  });

  const latestSession = sessionStore.get(sessionId);
  if (latestSession) {
    sessionStore.update(sessionId, {
      result: {
        ...latestSession.result,
        moduleActiveIds: (
          latestSession.result.moduleActiveIds ?? []
        ).filter((id) => id !== module.id),
        moduleAgentManifestPath,
        moduleAgentRuns,
        moduleAgentThreadIds: readPersistedModuleAgentThreadIds(sessionId),
        moduleFailedIds: failedModuleIds,
        moduleFailureKinds,
        moduleFailures,
        moduleMergeManifestPath,
        moduleValidationRuns,
      },
    });
  }

  return {
    failedModuleIds,
    moduleFailureKinds,
    moduleFailures,
    moduleAgentManifestPath,
    moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath,
    modulePlanPath,
    scaffoldHtmlPath,
  };
}

async function runModuleUserRevision(
  input: ModuleUserRevisionInput,
): Promise<ModulePipelineV2Result> {
  const revision = await runModuleUserRevisionTurn(input);
  const finalVerifyResult = await runVerify(
    input.sessionId,
    input.design.svgPath,
    input.artifactDir,
    input.round,
    true,
    { mode: "full", signal: input.controller.signal },
  );
  throwIfRunAborted(input.controller);
  const moduleValidationRuns = [
    ...revision.moduleValidationRuns,
    {
      diffRatio: finalVerifyResult.diffRatio,
      failedModuleIds: revision.failedModuleIds,
      moduleStats: [],
      round: input.round,
      scope: "merged-page" as const,
      threshold: getModuleDiffRatioThreshold(),
    },
  ];
  const latestSession = sessionStore.get(input.sessionId);
  if (latestSession) {
    sessionStore.update(input.sessionId, {
      result: {
        ...latestSession.result,
        moduleValidationRuns,
      },
    });
  }
  return {
    failedModuleIds: revision.failedModuleIds,
    moduleFailureKinds: revision.moduleFailureKinds,
    moduleAgentManifestPath: revision.moduleAgentManifestPath,
    moduleAgentRuns: revision.moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath: revision.moduleMergeManifestPath,
    modulePlanPath: revision.modulePlanPath,
    scaffoldHtmlPath: revision.scaffoldHtmlPath,
    verifyResult: finalVerifyResult,
  };
}

export { runModuleUserRevision, runModuleUserRevisionTurn };
export type { ModuleUserRevisionInput };
