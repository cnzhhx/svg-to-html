import path from "node:path";

import { getSemanticVisionConcurrency } from "../../../config/index.js";
import { normalizeOutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { writeJsonFile } from "../../../core/file-io.js";
import { sessionStore } from "../../../session-store.js";
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
import {
  normalizeModules,
  resolveSessionRenderEntryPath,
  type ModulePipelineV2Result,
} from "./module-pipeline-shared.js";
export {
  runModuleUserRevision,
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

  await runInitialModuleRound({
    artifactDir,
    controller,
    design,
    failedModuleKinds,
    failedModules,
    maxParallelModuleAgents,
    moduleAgentRuns,
    modulePlan,
    moduleThreads,
    modulesRootDir,
    modulesToRun: modules,
    outputFormat,
    persistedModuleThreadIds,
    sessionId,
    visionSemaphore,
  });
  throwIfRunAborted(controller);

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
