import path from "node:path";

import { getSemanticVisionConcurrency } from "../../../config/index.js";
import { normalizeOutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import { sessionStore } from "../../../session-store.js";
import type { SessionEvent } from "../../../session-store.js";
import type { AgentThread } from "../../agent-runtime/index.js";
import { readModulePlan } from "../../module-merge/index.js";

import { Semaphore } from "../queue/concurrency.js";
import { throwIfRunAborted } from "../session/run-control.js";
import {
  ensureScaffoldSnapshot,
} from "./module-artifacts.js";
import {
  type ModuleAgentRunRecord,
  type ModuleValidationFailureKind,
  type ModuleValidationRun,
} from "./module-pipeline-records.js";
import {
  readPersistedModuleAgentThreadIds,
} from "./module-thread-ids.js";
import { runInitialModuleRound } from "./module-initial-round.js";
import { collectAgentLocalValidation } from "./module-local-validation.js";
import {
  runModulePipelineFinalization,
} from "./module-finalize.js";
import { runModuleUserRevisionTurn } from "./module-user-revision.js";
import {
  normalizeModules,
  resolveSessionRenderEntryPath,
  type ModulePipelineV2Result,
} from "./module-pipeline-shared.js";
export {
  runModuleUserRevision,
  runModuleUserRevisionTurn,
  type ModuleUserRevisionInput,
} from "./module-user-revision.js";


type ModulePipelineV2Input = {
  controller: AbortController;
  design: ResolvedDesignTarget;
  maxParallelModuleAgents: number;
  sessionId: string;
};

export async function runModulePipelineV2(
  input: ModulePipelineV2Input,
): Promise<ModulePipelineV2Result> {
  const { controller, design, maxParallelModuleAgents, sessionId } = input;

  throwIfRunAborted(controller);

  const currentSession = sessionStore.get(sessionId);
  if (!currentSession?.result.modulePlanPath) {
    throw new Error("Module plan path not available");
  }

  const modulePlanPath = currentSession.result.modulePlanPath;
  const outputFormat = normalizeOutputFormat(currentSession.outputFormat);
  const renderEntryPath = resolveSessionRenderEntryPath({
    design,
    session: currentSession,
  });
  if (!renderEntryPath) {
    throw new Error("Render entry path not available");
  }
  const modulesRootDir = path.dirname(modulePlanPath);
  const artifactDir = path.dirname(modulesRootDir);
  let modulePlan = await readModulePlan(modulePlanPath);
  const scaffoldHtmlPath = await ensureScaffoldSnapshot({
    design,
    modulesRootDir,
  });
  const nextModulePlan = {
    ...modulePlan,
    outputFormat,
    renderEntryPath,
    scaffoldRenderPath: scaffoldHtmlPath,
    sourceEntryPath:
      currentSession.result.sourceEntryPath ??
      currentSession.outputTarget?.sourceEntryPath,
  };
  if (
    modulePlan.outputFormat !== nextModulePlan.outputFormat ||
    modulePlan.renderEntryPath !== nextModulePlan.renderEntryPath ||
    modulePlan.scaffoldRenderPath !== nextModulePlan.scaffoldRenderPath ||
    modulePlan.sourceEntryPath !== nextModulePlan.sourceEntryPath
  ) {
    modulePlan = {
      ...nextModulePlan,
    };
    await writeJsonFile(modulePlanPath, modulePlan);
  }
  const modules = normalizeModules(modulePlan);

  if (!modules.length) throw new Error("No modules found in module plan");
  const moduleMergeManifestPath = path.join(
    modulesRootDir,
    "module-merge-manifest.json",
  );
  const moduleAgentManifestPath = path.join(
    modulesRootDir,
    "module-agent-manifest.json",
  );
  const moduleThreads = new Map<string, AgentThread>();
  const moduleAgentRuns: ModuleAgentRunRecord[] = [];
  const moduleValidationRuns: ModuleValidationRun[] = [];
  const failedModules = new Map<string, string>();
  const failedModuleKinds = new Map<string, ModuleValidationFailureKind>();
  const persistedModuleThreadIds = readPersistedModuleAgentThreadIds(sessionId);

  const semanticVisionConcurrency = getSemanticVisionConcurrency();
  const visionSemaphore = new Semaphore(semanticVisionConcurrency);

  sessionStore.addLog(
    sessionId,
    `[module-pipeline-v2] starting unified module pipeline: modules=${modules.length}, maxParallel=${maxParallelModuleAgents}, visionConcurrency=${semanticVisionConcurrency}`,
  );

  const completedInitialModules = new Set<string>();
  const moduleTurnInterrupts = new Map<string, AbortController>();
  const activeLiveRevisions = new Map<string, Promise<void>>();
  let liveRevisionChain = Promise.resolve();
  const runLiveRevisionForModule = async (moduleId: string) => {
    if (!completedInitialModules.has(moduleId)) return;
    if (activeLiveRevisions.has(moduleId)) return activeLiveRevisions.get(moduleId);
    const module = modules.find((candidate) => candidate.id === moduleId);
    if (!module) return;
    const messages = sessionStore.dequeuePendingMessagesForModule(sessionId, moduleId);
    if (!messages.length) return;
    const task = liveRevisionChain.then(async () => {
      let batch = messages;
      while (batch.length) {
        const userInstructions = batch
          .map((message, index) => `用户补充 ${index + 1}: ${message.text}`)
          .join("\n");
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${moduleId}] applying ${batch.length} live user instruction(s) immediately`,
        );
        const revision = await runModuleUserRevisionTurn({
          artifactDir,
          controller,
          design,
          moduleId,
          moduleMergeManifestPath,
          modulePlanPath,
          moduleTurnInterrupts,
          promptMode: "guidance",
          publishFinalMerge: false,
          round:
            Math.max(
              1,
              ...moduleAgentRuns
                .filter((run) => run.id === moduleId)
                .map((run) => Number(run.round ?? 1)),
            ) + 1,
          scaffoldHtmlPath,
          sessionId,
          userInstructions,
        });
        moduleAgentRuns.splice(0, moduleAgentRuns.length, ...revision.moduleAgentRuns);
        moduleValidationRuns.splice(
          0,
          moduleValidationRuns.length,
          ...revision.moduleValidationRuns,
        );
        failedModules.clear();
        Object.entries(revision.moduleFailures).forEach(([id, message]) => {
          failedModules.set(id, message);
        });
        failedModuleKinds.clear();
        Object.entries(revision.moduleFailureKinds).forEach(([id, kind]) => {
          failedModuleKinds.set(id, kind as ModuleValidationFailureKind);
        });
        batch = sessionStore.dequeuePendingMessagesForModule(sessionId, moduleId);
      }
    }).finally(() => {
      activeLiveRevisions.delete(moduleId);
    });
    liveRevisionChain = task.catch(() => undefined);
    activeLiveRevisions.set(moduleId, task);
    return task;
  };
  const liveMessageListener = (event: SessionEvent) => {
    if (event.type !== "user-message:queued") return;
    if (event.sessionId !== sessionId) return;
    const moduleId = event.moduleId?.trim();
    if (!moduleId) return;
    const activeTurn = moduleTurnInterrupts.get(moduleId);
    if (activeTurn && !activeTurn.signal.aborted) {
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2:${moduleId}] user guidance received; interrupting current module turn`,
      );
      sessionStore.addMessage(sessionId, {
        id: `system-${Date.now()}-${moduleId}-interrupting`,
        kind: "event",
        moduleId,
        role: "system",
        text: `已收到 ${moduleId} 的中途引导，正在中断当前执行并切换方向。`,
      });
      activeTurn.abort("user-guidance-interrupt");
      return;
    }
    void runLiveRevisionForModule(moduleId).catch((error) => {
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2:${moduleId}] live user revision failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  sessionStore.on(`session:${sessionId}`, liveMessageListener);

  try {
    await runInitialModuleRound({
      artifactDir,
      completedInitialModules,
      controller,
      design,
      failedModuleKinds,
      failedModules,
      maxParallelModuleAgents,
      moduleAgentRuns,
      modulePlan,
      modulePlanPath,
      moduleTurnInterrupts,
      moduleThreads,
      modulesRootDir,
      modulesToRun: modules,
      onModuleInitialCompleted: async (moduleId) => {
        await runLiveRevisionForModule(moduleId);
      },
      outputFormat,
      persistedModuleThreadIds,
      scaffoldHtmlPath,
      sessionId,
      visionSemaphore,
    });
    await Promise.all([...activeLiveRevisions.values()]);
  } finally {
    sessionStore.off(`session:${sessionId}`, liveMessageListener);
  }
  throwIfRunAborted(controller);

  for (const module of modules) {
    const messages = sessionStore.dequeuePendingMessagesForModule(
      sessionId,
      module.id,
    );
    if (!messages.length) continue;
    const userInstructions = messages
      .map((message, index) => `用户补充 ${index + 1}: ${message.text}`)
      .join("\n");
    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2:${module.id}] applying ${messages.length} live user instruction(s) after initial turn`,
    );
    const revision = await runModuleUserRevisionTurn({
      artifactDir,
      controller,
      design,
      moduleId: module.id,
      moduleMergeManifestPath,
      modulePlanPath,
      moduleTurnInterrupts,
      promptMode: "guidance",
      publishFinalMerge: false,
      round:
        Math.max(
          1,
          ...moduleAgentRuns
            .filter((run) => run.id === module.id)
            .map((run) => Number(run.round ?? 1)),
        ) + 1,
      scaffoldHtmlPath,
      sessionId,
      userInstructions,
    });
    moduleAgentRuns.splice(0, moduleAgentRuns.length, ...revision.moduleAgentRuns);
    moduleValidationRuns.splice(
      0,
      moduleValidationRuns.length,
      ...revision.moduleValidationRuns,
    );
    failedModules.clear();
    Object.entries(revision.moduleFailures).forEach(([id, message]) => {
      failedModules.set(id, message);
    });
    failedModuleKinds.clear();
    Object.entries(revision.moduleFailureKinds).forEach(([id, kind]) => {
      failedModuleKinds.set(id, kind as ModuleValidationFailureKind);
    });
    throwIfRunAborted(controller);
  }

  await collectAgentLocalValidation({
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
  });
  throwIfRunAborted(controller);

  return runModulePipelineFinalization({
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
  });
}
