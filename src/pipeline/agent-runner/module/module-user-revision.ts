import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { AGENT_REASONING_EFFORTS } from "../../../config/agent-reasoning.js";
import {
  getModuleDiffRatioThreshold,
  getSemanticVisionConcurrency,
} from "../../../config/index.js";
import { normalizeOutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import { sessionStore } from "../../../session-store.js";
import { buildUserModuleRevisionPrompt } from "../../../prompts/module-agent.js";
import { readModulePlan, mergeModulesIntoHtml } from "../../module-merge/index.js";
import { archiveSessionCheckpoint } from "../archive/checkpoint.js";
import { Semaphore } from "../queue/concurrency.js";
import { throwIfRunAborted } from "../session/run-control.js";
import { runVerify } from "../verify/verify-step.js";
import {
  createAgentUnitThread,
  runAgentUnit,
} from "./agent-unit.js";
import {
  createModuleSemanticDraft,
  ensureModuleContextImages,
} from "./module-semantic.js";
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
  preprocessModuleSemantic,
  readAgentGeneratedAssetCount,
} from "./module-semantic-preprocess.js";
import {
  persistModuleAgentThreadId,
  readPersistedModuleAgentThreadIds,
} from "./module-thread-ids.js";
import { publishMergeReadiness } from "./module-finalize.js";

type ModuleUserRevisionInput = {
  artifactDir: string;
  controller: AbortController;
  design: ResolvedDesignTarget;
  moduleId: string;
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  round: number;
  scaffoldHtmlPath: string;
  sessionId: string;
  userInstructions: string;
};

async function runModuleUserRevision(
  input: ModuleUserRevisionInput,
): Promise<ModulePipelineV2Result> {
  const {
    artifactDir,
    controller,
    design,
    moduleId,
    moduleMergeManifestPath,
    modulePlanPath,
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
  const persistedModuleThreadIds = readPersistedModuleAgentThreadIds(sessionId);
  await mkdir(moduleDir, { recursive: true });
  throwIfRunAborted(controller);

  sessionStore.startWorkflowNode(sessionId, "agent", {
    detail: `正在按用户要求修复模块 ${module.id}`,
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
  const moduleSemanticDraft = await createModuleSemanticDraft({
    module,
    moduleDir,
    moduleSvgPath,
    scale: design.scale,
  });
  await ensureModuleContextImages({
    moduleDir,
    module,
    moduleSvgPath,
    sharedLayers: modulePlan.sharedLayers ?? [],
    scale: design.scale,
  });
  throwIfRunAborted(controller);
  sessionStore.addLog(
    sessionId,
    `[module-user-revision:${module.id}] semantic draft ready: ${moduleSemanticDraft.jsonPath}`,
  );
  const { moduleSemantic } = await preprocessModuleSemantic({
    controller,
    design,
    module,
    moduleDir,
    moduleSvgPath,
    sessionId,
    visionSemaphore: new Semaphore(getSemanticVisionConcurrency()),
  });
  throwIfRunAborted(controller);

  const thread = createAgentUnitThread({
    artifactDir,
    design,
    originalSvgPath: design.svgPath,
    reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
    threadId: persistedModuleThreadIds[module.id],
    workingDir: moduleDir,
  });
  const revisionPrompt = buildUserModuleRevisionPrompt({
    module,
    outputFormat,
    userInstructions,
  });
  const revisionPath = path.join(moduleDir, `revision-round-${round}.md`);
  await writeFile(revisionPath, revisionPrompt, "utf8");
  await archiveSessionCheckpoint({
    sessionId,
    round,
    stage: "agent",
    note: `Module user revision ${module.id} round ${round}`,
    materials: [
      {
        kind: "file" as const,
        label: "Module User Revision",
        sourcePath: revisionPath,
      },
    ],
  });

  const result = await runAgentUnit({
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
    revisionPrompt,
    onThreadStarted: (threadId) => {
      persistedModuleThreadIds[module.id] = threadId;
      persistModuleAgentThreadId({
        moduleId: module.id,
        sessionId,
        threadId,
      });
    },
    round,
    thread,
  });
  const agentGeneratedAssetCount =
    await readAgentGeneratedAssetCount(moduleDir);

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
        moduleSemanticJson: moduleSemantic.jsonPath,
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
  const mergeResult = await mergeModulesIntoHtml({
    design,
    modulePlanPath,
    outputTarget: design.outputTarget,
    renderEntryPath,
    scaffoldRenderPath: scaffoldHtmlPath,
    skipInvalidModules: true,
  });
  await writeJsonFile(moduleMergeManifestPath, mergeResult);
  await publishMergeReadiness({
    mergeResult,
    moduleMergeManifestPath,
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
  mergeResult.skippedModules.forEach((skipped) => {
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
      ...mergeResult.skippedModuleIds,
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

  const finalVerifyResult = await runVerify(
    sessionId,
    design.svgPath,
    artifactDir,
    round,
    true,
    { mode: "full", signal: controller.signal },
  );
  throwIfRunAborted(controller);
  const moduleValidationRuns = [
    ...((previousSession?.result.moduleValidationRuns ??
      []) as ModuleValidationRun[]),
    {
      diffRatio: finalVerifyResult.diffRatio,
      failedModuleIds,
      moduleStats: [],
      round,
      scope: "merged-page" as const,
      threshold: getModuleDiffRatioThreshold(),
    },
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
    moduleAgentManifestPath,
    moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath,
    modulePlanPath,
    scaffoldHtmlPath,
    verifyResult: finalVerifyResult,
  };
}

export { runModuleUserRevision };
export type { ModuleUserRevisionInput };
