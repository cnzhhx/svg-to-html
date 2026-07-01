import path from "node:path";
import { mkdir } from "node:fs/promises";

import { AGENT_REASONING_EFFORTS } from "../../../config/agent-reasoning.js";
import type { OutputFormat } from "../../../core/output-target.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { sessionStore } from "../../../session-store.js";
import type { AgentThread } from "../../agent-runtime/index.js";
import type { ModulePlan } from "../../module-merge/types.js";
import { finalizeModuleManifest } from "../../module-merge/finalize-module-manifest.js";
import { runWithLimit, type Semaphore } from "../queue/concurrency.js";
import { isAbortError, throwIfRunAborted } from "../session/run-control.js";
import {
  createAgentUnitThread,
  ModuleOutputIncompleteError,
  runAgentUnit,
  setModuleActive,
} from "./agent-unit.js";
import { buildUserModuleGuidancePrompt } from "../../../prompts/module-agent.js";
import {
  ensureModuleContextImages,
  ensureModuleReferenceImage,
  createModuleSemanticDraft,
  readModuleSemanticDocument,
} from "./module-semantic.js";
import {
  ensureModuleSvg,
  getModuleDir,
  getSourceFragmentPath,
  writeFailedModulePlaceholder,
} from "./module-artifacts.js";
import {
  getCachedInputTokens,
  getUncachedInputTokens,
  type ModuleAgentRunRecord,
  type ModuleValidationFailureKind,
} from "./module-pipeline-records.js";
import {
  assertModuleSemanticHasUsableInput,
  ModuleInputError,
  preprocessModuleSemantic,
  readAgentGeneratedAssetCount,
} from "./module-semantic-preprocess.js";
import { persistModuleAgentThreadId } from "./module-thread-ids.js";
import {
  publishLivePreview,
  requestLivePreviewRefresh,
} from "./live-preview.js";

type RunInitialModuleRoundInput = {
  artifactDir: string;
  completedInitialModules?: Set<string>;
  controller: AbortController;
  design: ResolvedDesignTarget;
  failedModuleKinds: Map<string, ModuleValidationFailureKind>;
  failedModules: Map<string, string>;
  maxParallelModuleAgents: number;
  moduleAgentRuns: ModuleAgentRunRecord[];
  modulePlan: ModulePlan;
  moduleThreads: Map<string, AgentThread>;
  modulesRootDir: string;
  modulesToRun: SvgVerticalModule[];
  onModuleInitialCompleted?: (moduleId: string) => Promise<void>;
  modulePlanPath: string;
  moduleTurnInterrupts?: Map<string, AbortController>;
  outputFormat: OutputFormat;
  persistedModuleThreadIds: Record<string, string>;
  scaffoldHtmlPath: string;
  sessionId: string;
  visionSemaphore: Semaphore;
};

const runInitialModuleRound = async ({
  artifactDir,
  completedInitialModules,
  controller,
  design,
  failedModuleKinds,
  failedModules,
  maxParallelModuleAgents,
  moduleAgentRuns,
  modulePlan,
  moduleThreads,
  modulesRootDir,
  modulesToRun,
  onModuleInitialCompleted,
  modulePlanPath,
  moduleTurnInterrupts,
  outputFormat,
  persistedModuleThreadIds,
  scaffoldHtmlPath,
  sessionId,
  visionSemaphore,
}: RunInitialModuleRoundInput) => {
  sessionStore.startWorkflowNode(sessionId, "agent", {
    detail: `正在并行生成 ${modulesToRun.length} 个模块`,
    iteration: 1,
    maxIterations: 1,
  });
  sessionStore.startStep(sessionId, "agent");
  // 串行预热 module-reference.png，避免多个模块并发 capturePage 争抢 browser instance
  for (const module of modulesToRun) {
    throwIfRunAborted(controller);
    const moduleDir = getModuleDir(modulesRootDir, module);
    await mkdir(moduleDir, { recursive: true });
    const moduleSvgPath = await ensureModuleSvg({
      design,
      module,
      modulesRootDir,
    });
    await ensureModuleReferenceImage({ moduleDir, moduleSvgPath, scale: design.scale });
    await ensureModuleContextImages({
      moduleDir,
      module,
      moduleSvgPath,
      sharedLayers: modulePlan.sharedLayers ?? [],
      scale: design.scale,
    });
  }
  await runWithLimit({
    items: modulesToRun,
    limit: maxParallelModuleAgents,
    signal: controller.signal,
    worker: async (module) => {
      const moduleDir = getModuleDir(modulesRootDir, module);
      throwIfRunAborted(controller);
      await mkdir(moduleDir, { recursive: true });
      const moduleSvgPath = await ensureModuleSvg({
        design,
        module,
        modulesRootDir,
      });
      const moduleSemanticDraft = await createModuleSemanticDraft({
        module,
        moduleDir,
        moduleSvgPath,
        scale: design.scale,
      });
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2:${module.id}] semantic draft ready: ${moduleSemanticDraft.jsonPath}`,
      );
      const {
        initialAgentGeneratedAssetCount,
        moduleSemantic,
        textBlocksFile,
      } = await preprocessModuleSemantic({
        controller,
        design,
        module,
        moduleDir,
        moduleSvgPath,
        sessionId,
        visionSemaphore,
      });
      throwIfRunAborted(controller);
      const moduleTextBlockCount = textBlocksFile.blockCount;
      const existingThread = moduleThreads.get(module.id);
      const persistedThreadId = persistedModuleThreadIds[module.id];
      const thread =
        existingThread ??
        createAgentUnitThread({
          artifactDir,
          design,
          originalSvgPath: design.svgPath,
          reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
          threadId: persistedThreadId,
          workingDir: moduleDir,
        });
      moduleThreads.set(module.id, thread);

      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2:${module.id}] initial generation: existingAgentGeneratedAssets=${initialAgentGeneratedAssetCount}, textBlocks=${moduleTextBlockCount}`,
      );

      const startedAt = Date.now();
      const moduleTurnInterrupt = new AbortController();
      moduleTurnInterrupts?.set(module.id, moduleTurnInterrupt);
      try {
        const initialUserMessages = sessionStore.dequeuePendingMessagesForModule(
          sessionId,
          module.id,
        );
        const initialUserInstructions = initialUserMessages
          .map((message, index) => `用户补充 ${index + 1}: ${message.text}`)
          .join("\n");
        if (initialUserInstructions) {
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] applying ${initialUserMessages.length} queued user instruction(s) to initial prompt`,
          );
        }
        assertModuleSemanticHasUsableInput({
          module,
          moduleSemantic: await readModuleSemanticDocument(moduleDir).then(
            (document) => {
              if (!document) {
                throw new ModuleInputError(
                  `module-semantic.json missing before agent run: ${module.id}`,
                );
              }
              return document;
            },
          ),
          textBlockCount: moduleTextBlockCount,
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
          interruptSignal: moduleTurnInterrupt.signal,
          interruptLabel: "user-guidance-interrupt",
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
          extraPrompt: initialUserInstructions
            ? buildUserModuleGuidancePrompt({
                module,
                userInstructions: initialUserInstructions,
              })
            : undefined,
          round: 1,
          thread,
        });
        if (result.interrupted) {
          moduleAgentRuns.push({
            cachedInputTokens: getCachedInputTokens(result.usage),
            durationMs: result.durationMs,
            endedAt: result.endedAt,
            error: result.interruptReason ?? "user guidance interrupted this turn",
            id: module.id,
            inputTokens: result.usage?.input_tokens ?? 0,
            agentGeneratedAssetCount:
              await readAgentGeneratedAssetCount(moduleDir).catch(
                () => initialAgentGeneratedAssetCount,
              ),
            outputPaths: {
              manifest: result.outputPaths.manifest,
              moduleCss: result.outputPaths.moduleCss,
              moduleSemanticJson: moduleSemantic.jsonPath,
              moduleSvg: result.outputPaths.moduleSvg,
              previewFragmentHtml: result.outputPaths.previewFragmentHtml,
              ...(result.outputPaths.sourceData === undefined
                ? {}
                : { sourceData: result.outputPaths.sourceData }),
              ...(result.outputPaths.sourceFragment === undefined
                ? {}
                : { sourceFragment: result.outputPaths.sourceFragment }),
            },
            outputTokens: result.usage?.output_tokens ?? 0,
            promptKind: result.promptKind,
            region: module.region,
            round: result.round,
            startedAt: result.startedAt,
            status: "interrupted",
            threadId: result.threadId,
            turnSummary: result.turnSummary,
            uncachedInputTokens: getUncachedInputTokens(result.usage),
          });
          const currentAfterInterrupt = sessionStore.get(sessionId);
          if (currentAfterInterrupt) {
            sessionStore.update(sessionId, {
              result: {
                ...currentAfterInterrupt.result,
                moduleActiveIds: (
                  currentAfterInterrupt.result.moduleActiveIds ?? []
                ).filter((id) => id !== module.id),
                moduleAgentRuns: [...moduleAgentRuns],
              },
            });
          }
          sessionStore.addMessage(sessionId, {
            id: `system-${Date.now()}-${module.id}-guided`,
            kind: "event",
            moduleId: module.id,
            role: "system",
            text: `已引导 ${module.id}，正在按新的用户要求继续。`,
          });
          completedInitialModules?.add(module.id);
          await onModuleInitialCompleted?.(module.id);
          return;
        }
        const agentGeneratedAssetCount =
          await readAgentGeneratedAssetCount(moduleDir);
        moduleAgentRuns.push({
          cachedInputTokens: getCachedInputTokens(result.usage),
          durationMs: result.durationMs,
          endedAt: result.endedAt,
          finalDiffRatio: result.finalDiffRatio,
          id: module.id,
          inputTokens: result.usage?.input_tokens ?? 0,
          outputByteSizes: result.outputByteSizes,
          agentGeneratedAssetCount,
          outputPaths: {
            manifest: result.outputPaths.manifest,
            moduleCss: result.outputPaths.moduleCss,
            moduleSemanticJson: moduleSemantic.jsonPath,
            moduleSvg: result.outputPaths.moduleSvg,
            previewFragmentHtml: result.outputPaths.previewFragmentHtml,
            ...(result.outputPaths.sourceData === undefined
              ? {}
              : { sourceData: result.outputPaths.sourceData }),
            ...(result.outputPaths.sourceFragment === undefined
              ? {}
              : { sourceFragment: result.outputPaths.sourceFragment }),
          },
          outputTokens: result.usage?.output_tokens ?? 0,
          promptKind: result.promptKind,
          region: module.region,
          round: 1,
          startedAt: result.startedAt,
          status: result.success ? "completed" : "failed",
          threadId: result.threadId,
          turnSummary: result.turnSummary,
          uncachedInputTokens: getUncachedInputTokens(result.usage),
        });
        const currentAfterRun = sessionStore.get(sessionId);
        if (currentAfterRun) {
          sessionStore.update(sessionId, {
            result: {
              ...currentAfterRun.result,
              moduleActiveIds: (
                currentAfterRun.result.moduleActiveIds ?? []
              ).filter((id) => id !== module.id),
              moduleAgentRuns: [...moduleAgentRuns],
            },
          });
        }
        if (result.success) {
          failedModules.delete(module.id);
          failedModuleKinds.delete(module.id);
          try {
            await finalizeModuleManifest({ moduleDir });
          } catch (finalizeError) {
            sessionStore.addLog(
              sessionId,
              `[module-pipeline-v2:${module.id}] finalize manifest warning: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}`,
            );
          }
        }
        completedInitialModules?.add(module.id);
        await publishLivePreview({
          design,
          modulePlanPath,
          scaffoldHtmlPath,
          sessionId,
        });
        await onModuleInitialCompleted?.(module.id);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw error;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        const endedAt = Date.now();
        const incompleteDiagnostics =
          error instanceof ModuleOutputIncompleteError
            ? error.diagnostics
            : undefined;
        const failedUsage = incompleteDiagnostics?.usage ?? null;
        const failureKind =
          error instanceof ModuleInputError
            ? "module_input_failed"
            : error instanceof ModuleOutputIncompleteError
              ? "incomplete_output"
              : "module_visual_failed";
        failedModules.set(module.id, message);
        failedModuleKinds.set(module.id, failureKind);
        await writeFailedModulePlaceholder({
          error: message,
          module,
          moduleDir,
          outputFormat,
        });
        const failedStartedAt = incompleteDiagnostics?.startedAt ?? startedAt;
        const failedEndedAt = incompleteDiagnostics?.endedAt ?? endedAt;
        const failedDurationMs =
          incompleteDiagnostics?.durationMs ?? failedEndedAt - failedStartedAt;
        const failedAgentGeneratedAssetCount =
          await readAgentGeneratedAssetCount(moduleDir).catch(
            () => initialAgentGeneratedAssetCount,
          );
        moduleAgentRuns.push({
          cachedInputTokens: getCachedInputTokens(failedUsage),
          durationMs: failedDurationMs,
          endedAt: failedEndedAt,
          error: message,
          id: module.id,
          inputTokens: failedUsage?.input_tokens ?? 0,
          agentGeneratedAssetCount: failedAgentGeneratedAssetCount,
          outputPaths: {
            manifest: path.join(moduleDir, "manifest.json"),
            moduleCss: path.join(moduleDir, "module.css"),
            moduleSemanticJson: moduleSemantic.jsonPath,
            moduleSvg: moduleSvgPath,
            previewFragmentHtml: path.join(
              moduleDir,
              "preview.fragment.html",
            ),
            ...(outputFormat === "html"
              ? {}
              : {
                  sourceFragment: getSourceFragmentPath(
                    moduleDir,
                    outputFormat,
                  ),
                  sourceData: path.join(moduleDir, "source-data.json"),
                }),
          },
          outputTokens: failedUsage?.output_tokens ?? 0,
          promptKind: incompleteDiagnostics?.promptKind ?? "initial",
          region: module.region,
          round: incompleteDiagnostics?.round ?? 1,
          startedAt: failedStartedAt,
          status: "failed",
          threadId: incompleteDiagnostics?.threadId ?? thread.id ?? "unknown",
          turnSummary: incompleteDiagnostics?.turnSummary,
          uncachedInputTokens: getUncachedInputTokens(failedUsage),
        });
        if (incompleteDiagnostics?.turnSummary.metrics) {
          const metrics = incompleteDiagnostics.turnSummary.metrics;
          const tracePath = metrics.runtimeTracePath
            ? path.relative(process.cwd(), metrics.runtimeTracePath)
            : "n/a";
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] incomplete output diagnostics: inputTokens=${failedUsage?.input_tokens ?? 0}, outputTokens=${failedUsage?.output_tokens ?? 0}, textChars=${metrics.textCharCount}, thinkChars=${metrics.thinkCharCount}, finalResponseChars=${incompleteDiagnostics.finalResponseChars}, trace=${tracePath}`,
          );
        }
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] initial generation failed (${failureKind}); continuing with placeholder: ${message}`,
        );
        const currentAfterFailure = sessionStore.get(sessionId);
        if (currentAfterFailure) {
          sessionStore.update(sessionId, {
            result: {
              ...currentAfterFailure.result,
              moduleActiveIds: (
                currentAfterFailure.result.moduleActiveIds ?? []
              ).filter((id) => id !== module.id),
              moduleAgentRuns: [...moduleAgentRuns],
            },
          });
        } else {
          setModuleActive({ active: false, moduleId: module.id, sessionId });
        }
        completedInitialModules?.add(module.id);
        await publishLivePreview({
          design,
          modulePlanPath,
          scaffoldHtmlPath,
          sessionId,
        });
        await onModuleInitialCompleted?.(module.id);
      } finally {
        if (moduleTurnInterrupts?.get(module.id) === moduleTurnInterrupt) {
          moduleTurnInterrupts.delete(module.id);
        }
      }
    },
  });
  sessionStore.completeStep(sessionId, "agent");
  sessionStore.completeWorkflowNode(
    sessionId,
    "agent",
    "模块初始生成完成，准备合并校验",
  );
};

export { runInitialModuleRound };
