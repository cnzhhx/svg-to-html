import { existsSync } from "node:fs";
import path from "node:path";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import { AGENT_REASONING_EFFORTS } from "../../config/agent-reasoning.js";
import { MODULE_DIFF_RATIO_THRESHOLD } from "../../config/runtime.js";
import {
  MODULE_SVG_CROP_VERSION,
  createModuleSvgCropFingerprint,
  cropModuleSvg,
} from "../../core/svg-vertical-modules/module-svg-crop.js";
import { createModuleTextBlocks } from "../../core/module-text-blocks.js";
import type { SvgVerticalModule } from "../../core/svg-vertical-modules/types.js";
import type { DesignPair } from "../../core/utils.js";
import { writeJsonFile } from "../../core/utils.js";
import { sessionStore } from "../../session-store.js";
import type { AgentThread } from "../agent-runtime/index.js";
import { mergeModulesIntoHtml, readModulePlan } from "../module-merge.js";
import type { VerifyResult } from "../verify/types.js";
import {
  buildAgentUnitFeedbackPrompt,
  createAgentUnitThread,
  runAgentUnit,
} from "./agent-unit.js";
import { MODULE_FEEDBACK_MAX } from "./config.js";
import { runWithLimit } from "./concurrency.js";
import { isAbortError, throwIfRunAborted } from "./run-control.js";
import { runVerify } from "./verify-step.js";
import { writeHostModuleAllowedAssets } from "./module-allowed-assets.js";
import { writeModuleInputSummary } from "./module-input-summary.js";
import {
  applyModuleTextStyleHintsToLayout,
  createModuleTextStyleHints,
} from "./module-text-style-hints.js";
import {
  readCachedModuleLocalVerify,
  verifyModuleLocal,
} from "./module-local-verify.js";

type ModulePipelineV2Input = {
  controller: AbortController;
  design: DesignPair;
  maxParallelModuleAgents: number;
  sessionId: string;
};

type ModuleUserFeedbackInput = {
  artifactDir: string;
  controller: AbortController;
  design: DesignPair;
  moduleId: string;
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  round: number;
  scaffoldHtmlPath: string;
  sessionId: string;
  userInstructions: string;
  verifyReportPath?: string;
};

type ModulePipelineV2Result = {
  failedModuleIds: string[];
  moduleAgentManifestPath: string;
  moduleAgentRuns: ModuleAgentRunRecord[];
  moduleValidationRuns: ModuleValidationRun[];
  moduleMergeManifestPath: string;
  modulePlanPath: string;
  scaffoldHtmlPath: string;
  verifyResult: VerifyResult;
};

const buildUserModuleFeedbackPrompt = ({
  module,
  userInstructions,
  verifyReportPath,
}: {
  module: SvgVerticalModule;
  userInstructions: string;
  verifyReportPath?: string;
}) =>
  `
## 用户指定模块修复

用户已经在页面上选择了模块 \`${module.id}\`，本轮只处理这个模块。不要启动总控 agent，不要修改最终 HTML、compare HTML、scaffold 或其他模块；最终 HTML 会由宿主流程在你完成后重新 deterministic merge。

用户调整要求:
${userInstructions}

${verifyReportPath ? `最新整页 verify report（只读参考）: ${verifyReportPath}` : ""}

请先阅读当前模块目录里的 fragment.html、fragment.css、text-layout.json、manifest.json，以及 Module Input Summary / Vision Text Blocks / allowed-assets。把用户要求转化为本模块源文件修改；如果涉及普通可读文字，继续使用 DOM 文本和 text-layout.json 维护布局。完成后可按需运行最多 2 次官方局部校验，不要运行整页 verify-design。宿主流程会自动重新合并并 full verify。
`.trim();

type ModuleSnapshot = {
  assetsSnapshotDir?: string;
  fragmentCss: string;
  fragmentHtml: string;
  manifest: string;
  textLayout: string;
  diffRatio: number;
};

type ModuleAgentRunRecord = {
  durationMs: number;
  endedAt: number;
  error?: string;
  feedbackInputDiffRatio?: number;
  id: string;
  inputTokens: number;
  outputByteSizes?: {
    fragmentCss: number;
    fragmentHtml: number;
    manifest: number;
    textLayout: number;
  };
  allowedAssetCount?: number;
  outputPaths?: {
    allowedAssets: string;
    fragmentCss: string;
    fragmentHtml: string;
    manifest: string;
    moduleInputSummaryJson?: string;
    moduleInputSummaryMarkdown?: string;
    moduleSvg: string;
    moduleOcrBlocks: string;
    moduleTextBlocks?: string;
    textStyleHints?: string;
    textLayout: string;
  };
  outputTokens: number;
  promptKind: "initial" | "feedback";
  region: SvgVerticalModule["region"];
  round: number;
  startedAt: number;
  status: "completed" | "failed";
  threadId: string;
  turnSummary?: {
    durationMs: number;
    earlyStopReason?: string;
    internalDiffTimeline: Array<{ diffRatio: number; round: number }>;
    totalCommands: number;
    totalInternalRounds: number;
    totalShellCommands?: number;
    verifyCount: number;
  };
};

type ModuleValidationStat = {
  diffPixels?: number;
  diffRatio: number;
  id: string;
  maxChannelDelta?: number;
  mergeError?: string;
  passed: boolean;
  verifyReportPath?: string;
};

type ModuleValidationRun = {
  draftHtmlPath?: string;
  diffRatio: number;
  moduleStats: ModuleValidationStat[];
  modulesNeedingFeedback: string[];
  round: number;
  scope: "agent-local" | "merged-page";
  threshold: number;
  verifyReportPath?: string;
};

const publishMergeReadiness = async ({
  mergeResult,
  moduleMergeManifestPath,
  sessionId,
}: {
  mergeResult: Awaited<ReturnType<typeof mergeModulesIntoHtml>>;
  moduleMergeManifestPath: string;
  sessionId: string;
}) => {
  const latestSession = sessionStore.get(sessionId);
  if (!latestSession) return;
  const skippedModuleCount = mergeResult.skippedModuleIds.length;
  sessionStore.update(sessionId, {
    result: {
      ...latestSession.result,
      finalOutputReady: mergeResult.moduleCount > 0 && skippedModuleCount === 0,
      moduleMergeManifestPath,
      moduleTextLayoutMissingSelectorCount:
        mergeResult.textLayoutMissingSelectorCount,
      moduleTextLayoutSelectorCheckPassed:
        mergeResult.textLayoutSelectorCheckPassed,
    },
  });
};

const normalizeModules = (
  modulePlan: Awaited<ReturnType<typeof readModulePlan>>,
) =>
  Array.isArray(modulePlan.modules)
    ? (modulePlan.modules as SvgVerticalModule[])
    : (Object.entries(modulePlan.modules ?? {}).map(([id, value]) => ({
        ...(typeof value === "object" && value ? value : {}),
        id,
      })) as SvgVerticalModule[]);

const readModuleSnapshot = async (
  moduleDir: string,
  diffRatio: number,
): Promise<ModuleSnapshot> => {
  const [fragmentHtml, fragmentCss, textLayout, manifest] = await Promise.all([
    readFile(path.join(moduleDir, "fragment.html"), "utf8"),
    readFile(path.join(moduleDir, "fragment.css"), "utf8"),
    readFile(path.join(moduleDir, "text-layout.json"), "utf8"),
    readFile(path.join(moduleDir, "manifest.json"), "utf8"),
  ]);

  const assetsDir = path.join(moduleDir, "assets");
  const assetsSnapshotDir = existsSync(assetsDir)
    ? path.join(
        moduleDir,
        ".module-snapshots",
        `assets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
    : undefined;
  if (assetsSnapshotDir) {
    await mkdir(path.dirname(assetsSnapshotDir), { recursive: true });
    await cp(assetsDir, assetsSnapshotDir, { recursive: true });
  }

  return {
    assetsSnapshotDir,
    diffRatio,
    fragmentCss,
    fragmentHtml,
    manifest,
    textLayout,
  };
};

const getFileMtimeMs = async (filePath: string) => {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return undefined;
  }
};

const canReuseGeneratedFile = async ({
  outputPath,
  sourcePaths,
}: {
  outputPath: string;
  sourcePaths: string[];
}) => {
  const outputMtime = await getFileMtimeMs(outputPath);
  if (outputMtime === undefined) return false;
  const sourceMtimes = await Promise.all(sourcePaths.map(getFileMtimeMs));
  return sourceMtimes.every(
    (sourceMtime) =>
      sourceMtime !== undefined && outputMtime + 1 >= sourceMtime,
  );
};

const readJsonBlockCount = async (filePath: string) => {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return 0;
    if (
      "blockCount" in parsed &&
      typeof (parsed as { blockCount?: unknown }).blockCount === "number"
    ) {
      return (parsed as { blockCount: number }).blockCount;
    }
    if (
      "blocks" in parsed &&
      Array.isArray((parsed as { blocks?: unknown }).blocks)
    ) {
      return (parsed as { blocks: unknown[] }).blocks.length;
    }
    return 0;
  } catch {
    return 0;
  }
};

const restoreModuleSnapshot = async (
  moduleDir: string,
  snapshot: ModuleSnapshot,
) => {
  const assetsDir = path.join(moduleDir, "assets");
  await Promise.all([
    writeFile(
      path.join(moduleDir, "fragment.html"),
      snapshot.fragmentHtml,
      "utf8",
    ),
    writeFile(
      path.join(moduleDir, "fragment.css"),
      snapshot.fragmentCss,
      "utf8",
    ),
    writeFile(
      path.join(moduleDir, "text-layout.json"),
      snapshot.textLayout,
      "utf8",
    ),
    writeFile(path.join(moduleDir, "manifest.json"), snapshot.manifest, "utf8"),
  ]);
  await rm(assetsDir, { force: true, recursive: true });
  if (snapshot.assetsSnapshotDir) {
    await cp(snapshot.assetsSnapshotDir, assetsDir, {
      force: true,
      recursive: true,
    });
  }
};

const hasCompleteModuleOutput = (moduleDir: string) =>
  ["fragment.html", "fragment.css", "text-layout.json", "manifest.json"].every(
    (fileName) => existsSync(path.join(moduleDir, fileName)),
  );

const restoreHostModuleArtifacts = async ({
  artifactDir,
  modules,
  modulesRootDir,
}: {
  artifactDir: string;
  modules: SvgVerticalModule[];
  modulesRootDir: string;
}) => {
  await Promise.all(
    modules.map(async (module) => {
      const moduleDir = getModuleDir(modulesRootDir, module);
      await mkdir(moduleDir, { recursive: true });
      await writeHostModuleAllowedAssets({
        artifactDir,
        module,
        moduleDir,
      });
    }),
  );
};

const writeFailedModulePlaceholder = async ({
  error,
  module,
  moduleDir,
}: {
  error: string;
  module: SvgVerticalModule;
  moduleDir: string;
}) => {
  if (hasCompleteModuleOutput(moduleDir)) return;
  await mkdir(moduleDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(moduleDir, "fragment.html"), "", "utf8"),
    writeFile(path.join(moduleDir, "fragment.css"), "", "utf8"),
    writeFile(
      path.join(moduleDir, "text-layout.json"),
      JSON.stringify({ blocks: [], rules: [] }, null, 2),
      "utf8",
    ),
    writeFile(
      path.join(moduleDir, "manifest.json"),
      JSON.stringify(
        {
          error,
          moduleId: module.id,
          status: "failed",
          textLayoutCoordinateSpace: "local",
        },
        null,
        2,
      ),
      "utf8",
    ),
  ]);
};

const getModuleDir = (modulesRootDir: string, module: SvgVerticalModule) =>
  path.join(modulesRootDir, module.id);

const getModuleSvgPath = (modulesRootDir: string, module: SvgVerticalModule) =>
  path.join(getModuleDir(modulesRootDir, module), "module.svg");

const ensureModuleSvg = async ({
  design,
  module,
  modulesRootDir,
}: {
  design: DesignPair;
  module: SvgVerticalModule;
  modulesRootDir: string;
}) => {
  const moduleSvgPath = getModuleSvgPath(modulesRootDir, module);
  const originalSvg = await readFile(design.svgPath, "utf8");
  const expectedVersion = `data-module-crop-version="${MODULE_SVG_CROP_VERSION}"`;
  const expectedFingerprint = `data-module-crop-fingerprint="${createModuleSvgCropFingerprint(
    {
      module,
      originalSvg,
      scale: design.scale,
    },
  )}"`;
  let needsCrop = true;
  if (existsSync(moduleSvgPath)) {
    const currentModuleSvg = await readFile(moduleSvgPath, "utf8");
    needsCrop = ![expectedVersion, expectedFingerprint].every((marker) =>
      currentModuleSvg.includes(marker),
    );
  }
  if (needsCrop) {
    await cropModuleSvg({
      originalSvgPath: design.svgPath,
      originalSvgSource: originalSvg,
      module,
      outputPath: moduleSvgPath,
      scale: design.scale,
    });
  }
  return moduleSvgPath;
};

const ensureScaffoldSnapshot = async ({
  design,
  modulesRootDir,
}: {
  design: DesignPair;
  modulesRootDir: string;
}) => {
  const scaffoldHtmlPath = path.join(modulesRootDir, "modules-scaffold.html");
  if (!existsSync(scaffoldHtmlPath)) {
    await mkdir(modulesRootDir, { recursive: true });
    await copyFile(design.htmlPath, scaffoldHtmlPath);
  }
  return scaffoldHtmlPath;
};

const findModuleDiffRatio = (
  verifyResult: VerifyResult,
  module: SvgVerticalModule,
) =>
  verifyResult.moduleRegionStats?.find((stat) => stat.id === module.id)
    ?.diffRatio ?? 1;

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
  const modulesRootDir = path.dirname(modulePlanPath);
  const artifactDir = path.dirname(modulesRootDir);
  let modulePlan = await readModulePlan(modulePlanPath);
  if (modulePlan.textLayoutCoordinateSpace !== "local") {
    modulePlan = {
      ...modulePlan,
      textLayoutCoordinateSpace: "local",
    };
    await writeJsonFile(modulePlanPath, modulePlan);
  }
  const modules = normalizeModules(modulePlan);

  if (!modules.length) throw new Error("No modules found in module plan");

  const scaffoldHtmlPath = await ensureScaffoldSnapshot({
    design,
    modulesRootDir,
  });
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
  const bestSnapshots = new Map<string, ModuleSnapshot>();
  const failedModules = new Map<string, string>();
  let latestModuleStats = new Map<string, ModuleValidationStat>();

  sessionStore.addLog(
    sessionId,
    `[module-pipeline-v2] starting unified module pipeline: modules=${modules.length}, maxParallel=${maxParallelModuleAgents}`,
  );

  const runModuleRound = async ({
    modulesToRun,
    round,
    verifyResult,
    feedbackDiffByModule,
  }: {
    modulesToRun: SvgVerticalModule[];
    round: number;
    verifyResult?: VerifyResult;
    feedbackDiffByModule?: Map<string, number>;
  }) => {
    sessionStore.startWorkflowNode(sessionId, "agent", {
      detail:
        round > 1
          ? `正在执行第 ${round} 轮模块反馈：${modulesToRun.length} 个模块`
          : `正在并行生成 ${modulesToRun.length} 个模块`,
      iteration: round,
      maxIterations: MODULE_FEEDBACK_MAX,
    });
    sessionStore.startStep(sessionId, "agent");
    await runWithLimit({
      items: modulesToRun,
      limit: maxParallelModuleAgents,
      signal: controller.signal,
      worker: async (module) => {
        const moduleDir = getModuleDir(modulesRootDir, module);
        await mkdir(moduleDir, { recursive: true });
        const allowedAssets = await writeHostModuleAllowedAssets({
          artifactDir,
          module,
          moduleDir,
        });
        const moduleSvgPath = await ensureModuleSvg({
          design,
          module,
          modulesRootDir,
        });
        const moduleTextBlocksPath = path.join(
          moduleDir,
          "module-text-blocks.json",
        );
        const moduleTextBlocksReused = await canReuseGeneratedFile({
          outputPath: moduleTextBlocksPath,
          sourcePaths: [
            allowedAssets.allowedAssetsPath,
            allowedAssets.moduleOcrBlocksPath,
            moduleSvgPath,
          ],
        });
        if (!moduleTextBlocksReused) {
          await createModuleTextBlocks({
            moduleDir,
            moduleId: module.id,
            moduleOcrBlocksPath: allowedAssets.moduleOcrBlocksPath,
            moduleSvgPath,
            outputPath: moduleTextBlocksPath,
            region: module.region,
            scale: design.scale,
          });
        }
        const moduleTextStyleHintsPath = path.join(
          moduleDir,
          "module-text-style-hints.json",
        );
        let moduleTextStyleHintCount = 0;
        const moduleTextStyleHintsReused = await canReuseGeneratedFile({
          outputPath: moduleTextStyleHintsPath,
          sourcePaths: [moduleTextBlocksPath],
        });
        if (moduleTextStyleHintsReused) {
          moduleTextStyleHintCount = await readJsonBlockCount(
            moduleTextStyleHintsPath,
          );
        } else {
          try {
            const styleHints = await createModuleTextStyleHints({
              moduleDir,
              moduleId: module.id,
              moduleTextBlocksPath,
              outputPath: moduleTextStyleHintsPath,
            });
            moduleTextStyleHintCount = styleHints.blockCount;
          } catch (error) {
            sessionStore.addLog(
              sessionId,
              `[module-pipeline-v2:${module.id}] text style hint inference failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const moduleInputSummary = await writeModuleInputSummary({
          allowedAssetsPath: allowedAssets.allowedAssetsPath,
          module,
          moduleDir,
          moduleOcrBlocksPath: allowedAssets.moduleOcrBlocksPath,
          moduleTextStyleHintsPath: existsSync(moduleTextStyleHintsPath)
            ? moduleTextStyleHintsPath
            : undefined,
          moduleTextBlocksPath,
          moduleSvgPath,
          scale: design.scale,
        });
        const existingThread = moduleThreads.get(module.id);
        const thread =
          existingThread ??
          createAgentUnitThread({
            artifactDir,
            moduleSvgPath,
            originalSvgPath: design.svgPath,
            reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
            workingDir: moduleDir,
          });
        moduleThreads.set(module.id, thread);

        const diffRatio = verifyResult
          ? findModuleDiffRatio(verifyResult, module)
          : feedbackDiffByModule?.get(module.id);
        const feedbackPrompt =
          round > 1 && diffRatio !== undefined
            ? buildAgentUnitFeedbackPrompt({
                module,
                feedbackRound: round - 1,
                diffRatio,
                mergeError: failedModules.get(module.id),
                threshold: MODULE_DIFF_RATIO_THRESHOLD,
              })
            : undefined;

        if (feedbackPrompt) {
          await writeFile(
            path.join(moduleDir, `feedback-round-${round}.md`),
            feedbackPrompt,
            "utf8",
          );
        }

        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] round ${round}: ${feedbackPrompt ? "feedback" : "initial generation"}, allowedAssets=${allowedAssets.assetCount}, ocrBlocks=${allowedAssets.ocrBlockCount}, textBlocks=${moduleTextBlocksReused ? "cached" : "fresh"}, textStyleHints=${moduleTextStyleHintCount}${moduleTextStyleHintsReused ? " cached" : ""}`,
        );

        const startedAt = Date.now();
        try {
          const result = await runAgentUnit({
            module,
            moduleSvgPath,
            originalSvgPath: design.svgPath,
            design,
            workingDir: moduleDir,
            scaffoldHtmlPath,
            artifactDir,
            modulePlan: modulePlan as any,
            reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
            sessionId,
            controller,
            feedbackPrompt,
            round,
            thread,
          });
          if (existsSync(moduleTextStyleHintsPath)) {
            try {
              const applyResult = await applyModuleTextStyleHintsToLayout({
                hintsPath: moduleTextStyleHintsPath,
                textLayoutPath: path.join(moduleDir, "text-layout.json"),
              });
              sessionStore.addLog(
                sessionId,
                `[module-pipeline-v2:${module.id}] text style hints applied: ${applyResult.appliedBlockCount}/${applyResult.hintCount} block(s)`,
              );
            } catch (error) {
              sessionStore.addLog(
                sessionId,
                `[module-pipeline-v2:${module.id}] text style hint apply failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          const restoredAllowedAssets = await writeHostModuleAllowedAssets({
            artifactDir,
            module,
            moduleDir,
          });

          moduleAgentRuns.push({
            allowedAssetCount: restoredAllowedAssets.assetCount,
            durationMs: result.durationMs,
            endedAt: result.endedAt,
            feedbackInputDiffRatio: diffRatio,
            id: module.id,
            inputTokens: result.usage?.input_tokens ?? 0,
            outputByteSizes: result.outputByteSizes,
            outputPaths: {
              ...result.outputPaths,
              allowedAssets: restoredAllowedAssets.allowedAssetsPath,
              moduleInputSummaryJson: moduleInputSummary.jsonPath,
              moduleInputSummaryMarkdown: moduleInputSummary.markdownPath,
              moduleOcrBlocks: restoredAllowedAssets.moduleOcrBlocksPath,
              moduleTextBlocks: moduleTextBlocksPath,
              textStyleHints: moduleTextStyleHintsPath,
            },
            outputTokens: result.usage?.output_tokens ?? 0,
            promptKind: result.promptKind,
            region: module.region,
            round,
            startedAt: result.startedAt,
            status: result.success ? "completed" : "failed",
            threadId: result.threadId,
            turnSummary: result.turnSummary,
          });
          if (result.success) failedModules.delete(module.id);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) {
            throw error;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          const endedAt = Date.now();
          failedModules.set(module.id, message);
          await writeFailedModulePlaceholder({
            error: message,
            module,
            moduleDir,
          });
          const restoredAllowedAssets = await writeHostModuleAllowedAssets({
            artifactDir,
            module,
            moduleDir,
          });
          moduleAgentRuns.push({
            allowedAssetCount: restoredAllowedAssets.assetCount,
            durationMs: endedAt - startedAt,
            endedAt,
            error: message,
            feedbackInputDiffRatio: diffRatio,
            id: module.id,
            inputTokens: 0,
            outputTokens: 0,
            outputPaths: {
              allowedAssets: restoredAllowedAssets.allowedAssetsPath,
              fragmentCss: path.join(moduleDir, "fragment.css"),
              fragmentHtml: path.join(moduleDir, "fragment.html"),
              manifest: path.join(moduleDir, "manifest.json"),
              moduleInputSummaryJson: moduleInputSummary.jsonPath,
              moduleInputSummaryMarkdown: moduleInputSummary.markdownPath,
              moduleSvg: moduleSvgPath,
              moduleOcrBlocks: restoredAllowedAssets.moduleOcrBlocksPath,
              moduleTextBlocks: moduleTextBlocksPath,
              textStyleHints: moduleTextStyleHintsPath,
              textLayout: path.join(moduleDir, "text-layout.json"),
            },
            promptKind: feedbackPrompt ? "feedback" : "initial",
            region: module.region,
            round,
            startedAt,
            status: "failed",
            threadId: thread.id ?? "unknown",
          });
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] round ${round} failed; continuing with placeholder: ${message}`,
          );
        }
      },
    });
    const latestSession = sessionStore.get(sessionId);
    const previousInputTokens = Number(latestSession?.result.inputTokens ?? 0);
    const previousOutputTokens = Number(
      latestSession?.result.outputTokens ?? 0,
    );
    const roundInputTokens = moduleAgentRuns
      .filter((run) => run.round === round)
      .reduce((sum, run) => sum + run.inputTokens, 0);
    const roundOutputTokens = moduleAgentRuns
      .filter((run) => run.round === round)
      .reduce((sum, run) => sum + run.outputTokens, 0);
    sessionStore.completeStep(sessionId, "agent", {
      inputTokens: previousInputTokens + roundInputTokens,
      outputTokens: previousOutputTokens + roundOutputTokens,
      tokensUsed:
        previousInputTokens +
        previousOutputTokens +
        roundInputTokens +
        roundOutputTokens,
    });
    sessionStore.completeWorkflowNode(
      sessionId,
      "agent",
      round > 1
        ? `第 ${round} 轮模块反馈完成`
        : "模块初始生成完成，准备合并校验",
    );
  };

  const collectAgentLocalValidationRound = async ({
    modulesToValidate,
    round,
  }: {
    modulesToValidate: SvgVerticalModule[];
    round: number;
  }) => {
    sessionStore.startWorkflowNode(sessionId, "verify", {
      detail: `正在收集第 ${round} 轮模块局部 diff 结果：${modulesToValidate.length}/${modules.length} 个模块`,
      iteration: round,
      maxIterations: MODULE_FEEDBACK_MAX,
    });
    sessionStore.startStep(sessionId, "verify");
    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2] round ${round}: collect agent local module diff for ${modulesToValidate.length}/${modules.length} module(s)`,
    );

    const candidateSnapshots = new Map<string, ModuleSnapshot>();
    const validatedStats = await runWithLimit({
      items: modulesToValidate,
      limit: maxParallelModuleAgents,
      signal: controller.signal,
      worker: async (module) => {
        const moduleDir = getModuleDir(modulesRootDir, module);
        const moduleSvgPath = await ensureModuleSvg({
          design,
          module,
          modulesRootDir,
        });
        let mergeError = failedModules.get(module.id);
        const hasOutput = hasCompleteModuleOutput(moduleDir);
        let localVerify = null as Awaited<
          ReturnType<typeof verifyModuleLocal>
        > | null;
        let usedCachedVerify = false;

        if (!mergeError && hasOutput) {
          try {
            const cached = await readCachedModuleLocalVerify({
              module,
              moduleDir,
              modulePlan,
              modulePlanPath,
              moduleSvgPath,
              round,
              scale: design.scale,
              scaffoldHtmlPath,
            });
            if (cached) {
              localVerify = cached;
              usedCachedVerify = true;
            } else {
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
                round,
                scale: design.scale,
                scaffoldHtmlPath,
              });
            }
          } catch (error) {
            mergeError = error instanceof Error ? error.message : String(error);
            failedModules.set(module.id, mergeError);
          }
        }

        const diffRatio = localVerify?.diffRatio ?? 1;
        const passed =
          !mergeError &&
          hasOutput &&
          Boolean(localVerify) &&
          diffRatio <= MODULE_DIFF_RATIO_THRESHOLD;

        if (!mergeError && hasOutput && localVerify) {
          candidateSnapshots.set(
            module.id,
            await readModuleSnapshot(moduleDir, diffRatio),
          );
        }

        if (!hasOutput) {
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] incomplete module output; scheduling feedback`,
          );
        } else if (mergeError) {
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] local verify failed: ${mergeError}`,
          );
        } else if (!localVerify) {
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] no module-local verify result; scheduling feedback`,
          );
        } else {
          sessionStore.addLog(
            sessionId,
            `[module-pipeline-v2:${module.id}] module-local diffRatio=${(diffRatio * 100).toFixed(2)}%${usedCachedVerify ? " (cached)" : ""}`,
          );
        }

        return {
          diffPixels: localVerify?.diffPixels,
          diffRatio,
          id: module.id,
          mergeError,
          passed,
          verifyReportPath: localVerify?.verifyReportPath,
        };
      },
    });

    await restoreHostModuleArtifacts({
      artifactDir,
      modules,
      modulesRootDir,
    });
    const draftHtmlPath = path.join(
      modulesRootDir,
      `draft-round-${round}.html`,
    );
    const draftMergeResult = await mergeModulesIntoHtml({
      modulePlanPath,
      outputHtmlPath: draftHtmlPath,
      skipInvalidModules: true,
      scaffoldHtmlPath,
    });
    const statsById = new Map<string, ModuleValidationStat>(
      validatedStats.map((stat) => [stat.id, stat]),
    );
    draftMergeResult.skippedModules.forEach((skipped) => {
      failedModules.set(skipped.id, skipped.error);
      const stat =
        statsById.get(skipped.id) ??
        latestModuleStats.get(skipped.id) ??
        ({
          diffRatio: 1,
          id: skipped.id,
          passed: false,
        } satisfies ModuleValidationStat);
      stat.mergeError = skipped.error;
      stat.passed = false;
      statsById.set(skipped.id, stat);
    });
    const moduleStats = modules.map((module) => {
      const existing =
        statsById.get(module.id) ?? latestModuleStats.get(module.id);
      if (existing) {
        const mergeError = failedModules.get(module.id);
        return mergeError
          ? { ...existing, mergeError, passed: false }
          : { ...existing };
      }
      return {
        diffRatio: 1,
        id: module.id,
        mergeError:
          failedModules.get(module.id) ?? "module was not validated in this run",
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

    const modulesNeedingFeedback = modules.filter((module) => {
      const stat = moduleStats.find((candidate) => candidate.id === module.id);
      return !stat?.passed || failedModules.has(module.id);
    });
    const maxDiffRatio = moduleStats.reduce(
      (max, stat) => Math.max(max, stat.diffRatio),
      0,
    );
    const feedbackDiffByModule = new Map(
      moduleStats.map((stat) => [stat.id, stat.diffRatio]),
    );
    latestModuleStats = new Map(moduleStats.map((stat) => [stat.id, stat]));

    moduleValidationRuns.push({
      draftHtmlPath,
      diffRatio: maxDiffRatio,
      moduleStats,
      modulesNeedingFeedback: modulesNeedingFeedback.map((module) => module.id),
      round,
      scope: "agent-local",
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
    });
    sessionStore.completeWorkflowNode(
      sessionId,
      "verify",
      `第 ${round} 轮模块局部 diff 结果已收集，需反馈 ${modulesNeedingFeedback.length} 个模块`,
    );
    sessionStore.completeStep(sessionId, "verify", {
      moduleValidationRuns,
    });

    return {
      feedbackDiffByModule,
      modulesNeedingFeedback,
    };
  };

  await runModuleRound({ modulesToRun: modules, round: 1 });
  throwIfRunAborted(controller);

  let modulesToValidateNext = modules;
  for (let round = 1; round <= MODULE_FEEDBACK_MAX; round++) {
    const { feedbackDiffByModule, modulesNeedingFeedback } =
      await collectAgentLocalValidationRound({
        modulesToValidate: modulesToValidateNext,
        round,
      });
    throwIfRunAborted(controller);

    if (!modulesNeedingFeedback.length || round >= MODULE_FEEDBACK_MAX) break;

    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2] round ${round + 1}: feedback modules=${modulesNeedingFeedback.map((module) => module.id).join(", ")}`,
    );
    await runModuleRound({
      modulesToRun: modulesNeedingFeedback,
      feedbackDiffByModule,
      round: round + 1,
    });
    modulesToValidateNext = modulesNeedingFeedback;
    throwIfRunAborted(controller);
  }

  sessionStore.addLog(
    sessionId,
    "[module-pipeline-v2] restoring best snapshots",
  );
  for (const [moduleId, snapshot] of bestSnapshots) {
    await restoreModuleSnapshot(path.join(modulesRootDir, moduleId), snapshot);
  }

  await restoreHostModuleArtifacts({
    artifactDir,
    modules,
    modulesRootDir,
  });
  const finalMergeResult = await mergeModulesIntoHtml({
    modulePlanPath,
    outputHtmlPath: design.htmlPath,
    skipInvalidModules: true,
    scaffoldHtmlPath,
  });
  finalMergeResult.skippedModules.forEach((skipped) => {
    failedModules.set(skipped.id, skipped.error);
  });
  await writeJsonFile(moduleMergeManifestPath, finalMergeResult);
  await publishMergeReadiness({
    mergeResult: finalMergeResult,
    moduleMergeManifestPath,
    sessionId,
  });

  const finalVerifyResult = await runVerify(
    sessionId,
    design.svgPath,
    artifactDir,
    MODULE_FEEDBACK_MAX + 1,
    true,
    { mode: "full" },
  );
  moduleValidationRuns.push({
    diffRatio: finalVerifyResult.diffRatio,
    moduleStats:
      finalVerifyResult.moduleRegionStats?.map((stat) => ({
        diffPixels: stat.diffPixels,
        diffRatio: stat.diffRatio,
        id: stat.id,
        maxChannelDelta: stat.maxChannelDelta,
        passed: stat.diffRatio <= MODULE_DIFF_RATIO_THRESHOLD,
      })) ?? [],
    modulesNeedingFeedback: [],
    round: MODULE_FEEDBACK_MAX + 1,
    scope: "merged-page",
    threshold: MODULE_DIFF_RATIO_THRESHOLD,
    verifyReportPath: finalVerifyResult.verifyReportPath,
  });
  const completedAgentLocalRounds = moduleValidationRuns.filter(
    (run) => run.scope === "agent-local",
  ).length;
  await writeJsonFile(moduleAgentManifestPath, {
    concurrency: maxParallelModuleAgents,
    moduleCount: modules.length,
    runs: moduleAgentRuns,
    validation: {
      failedModuleIds: [...failedModules.keys()].sort(),
      maxIterations: MODULE_FEEDBACK_MAX,
      rounds: completedAgentLocalRounds,
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
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
        moduleFailedIds: [...failedModules.keys()].sort(),
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
    moduleAgentManifestPath,
    moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath,
    modulePlanPath,
    scaffoldHtmlPath,
    verifyResult: finalVerifyResult,
  };
}

export async function runModuleUserFeedback(
  input: ModuleUserFeedbackInput,
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
    verifyReportPath,
  } = input;

  const modulePlan = await readModulePlan(modulePlanPath);
  const modules = normalizeModules(modulePlan);
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new Error(`模块不存在：${moduleId}`);
  }

  const modulesRootDir = path.dirname(modulePlanPath);
  const moduleAgentManifestPath = path.join(
    modulesRootDir,
    "module-agent-manifest.json",
  );
  const moduleDir = getModuleDir(modulesRootDir, module);
  await mkdir(moduleDir, { recursive: true });

  sessionStore.startWorkflowNode(sessionId, "agent", {
    detail: `正在按用户要求修复模块 ${module.id}`,
    iteration: round,
    maxIterations: round,
  });
  sessionStore.startStep(sessionId, "agent");
  sessionStore.addLog(
    sessionId,
    `[module-user-feedback:${module.id}] starting user-selected module turn`,
  );

  const allowedAssets = await writeHostModuleAllowedAssets({
    artifactDir,
    module,
    moduleDir,
  });
  const moduleSvgPath = await ensureModuleSvg({
    design,
    module,
    modulesRootDir,
  });
  const moduleTextBlocksPath = path.join(moduleDir, "module-text-blocks.json");
  const moduleTextBlocksReused = await canReuseGeneratedFile({
    outputPath: moduleTextBlocksPath,
    sourcePaths: [
      allowedAssets.allowedAssetsPath,
      allowedAssets.moduleOcrBlocksPath,
      moduleSvgPath,
    ],
  });
  if (!moduleTextBlocksReused) {
    await createModuleTextBlocks({
      moduleDir,
      moduleId: module.id,
      moduleOcrBlocksPath: allowedAssets.moduleOcrBlocksPath,
      moduleSvgPath,
      outputPath: moduleTextBlocksPath,
      region: module.region,
      scale: design.scale,
    });
  }
  const moduleTextStyleHintsPath = path.join(
    moduleDir,
    "module-text-style-hints.json",
  );
  const moduleTextStyleHintsReused = await canReuseGeneratedFile({
    outputPath: moduleTextStyleHintsPath,
    sourcePaths: [moduleTextBlocksPath],
  });
  if (!moduleTextStyleHintsReused) {
    try {
      await createModuleTextStyleHints({
        moduleDir,
        moduleId: module.id,
        moduleTextBlocksPath,
        outputPath: moduleTextStyleHintsPath,
      });
    } catch (error) {
      sessionStore.addLog(
        sessionId,
        `[module-user-feedback:${module.id}] text style hint inference failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const moduleInputSummary = await writeModuleInputSummary({
    allowedAssetsPath: allowedAssets.allowedAssetsPath,
    module,
    moduleDir,
    moduleOcrBlocksPath: allowedAssets.moduleOcrBlocksPath,
    moduleTextStyleHintsPath: existsSync(moduleTextStyleHintsPath)
      ? moduleTextStyleHintsPath
      : undefined,
    moduleTextBlocksPath,
    moduleSvgPath,
    scale: design.scale,
  });

  const thread = createAgentUnitThread({
    artifactDir,
    moduleSvgPath,
    originalSvgPath: design.svgPath,
    reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
    workingDir: moduleDir,
  });
  const result = await runAgentUnit({
    module,
    moduleSvgPath,
    originalSvgPath: design.svgPath,
    design,
    workingDir: moduleDir,
    scaffoldHtmlPath,
    artifactDir,
    modulePlan: modulePlan as any,
    reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
    sessionId,
    controller,
    feedbackPrompt: buildUserModuleFeedbackPrompt({
      module,
      userInstructions,
      verifyReportPath,
    }),
    round,
    thread,
  });

  if (existsSync(moduleTextStyleHintsPath)) {
    try {
      await applyModuleTextStyleHintsToLayout({
        hintsPath: moduleTextStyleHintsPath,
        textLayoutPath: path.join(moduleDir, "text-layout.json"),
      });
    } catch (error) {
      sessionStore.addLog(
        sessionId,
        `[module-user-feedback:${module.id}] text style hint apply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const previousSession = sessionStore.get(sessionId);
  const previousRuns = Array.isArray(previousSession?.result.moduleAgentRuns)
    ? (previousSession.result.moduleAgentRuns as ModuleAgentRunRecord[])
    : [];
  const moduleAgentRuns: ModuleAgentRunRecord[] = [
    ...previousRuns,
    {
      allowedAssetCount: allowedAssets.assetCount,
      durationMs: result.durationMs,
      endedAt: result.endedAt,
      id: module.id,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputByteSizes: result.outputByteSizes,
      outputPaths: {
        ...result.outputPaths,
        allowedAssets: allowedAssets.allowedAssetsPath,
        moduleInputSummaryJson: moduleInputSummary.jsonPath,
        moduleInputSummaryMarkdown: moduleInputSummary.markdownPath,
        moduleOcrBlocks: allowedAssets.moduleOcrBlocksPath,
        moduleTextBlocks: moduleTextBlocksPath,
        textStyleHints: moduleTextStyleHintsPath,
      },
      outputTokens: result.usage?.output_tokens ?? 0,
      promptKind: "feedback",
      region: module.region,
      round,
      startedAt: result.startedAt,
      status: result.success ? "completed" : "failed",
      threadId: result.threadId,
      turnSummary: result.turnSummary,
    },
  ];

  const previousInputTokens = Number(previousSession?.result.inputTokens ?? 0);
  const previousOutputTokens = Number(previousSession?.result.outputTokens ?? 0);
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;
  sessionStore.completeStep(sessionId, "agent", {
    inputTokens: previousInputTokens + inputTokens,
    outputTokens: previousOutputTokens + outputTokens,
    tokensUsed:
      previousInputTokens + previousOutputTokens + inputTokens + outputTokens,
  });
  sessionStore.completeWorkflowNode(
    sessionId,
    "agent",
    `模块 ${module.id} 用户修复已完成，准备合并校验`,
  );
  throwIfRunAborted(controller);

  await restoreHostModuleArtifacts({
    artifactDir,
    modules,
    modulesRootDir,
  });
  const mergeResult = await mergeModulesIntoHtml({
    modulePlanPath,
    outputHtmlPath: design.htmlPath,
    scaffoldHtmlPath,
    skipInvalidModules: true,
  });
  await writeJsonFile(moduleMergeManifestPath, mergeResult);
  await publishMergeReadiness({
    mergeResult,
    moduleMergeManifestPath,
    sessionId,
  });

  const finalVerifyResult = await runVerify(
    sessionId,
    design.svgPath,
    artifactDir,
    round,
    true,
    { mode: "full", reuseCachedOcr: false },
  );
  const moduleValidationRuns = [
    ...((previousSession?.result.moduleValidationRuns ??
      []) as ModuleValidationRun[]),
    {
      diffRatio: finalVerifyResult.diffRatio,
      moduleStats:
        finalVerifyResult.moduleRegionStats?.map((stat) => ({
          diffPixels: stat.diffPixels,
          diffRatio: stat.diffRatio,
          id: stat.id,
          maxChannelDelta: stat.maxChannelDelta,
          passed: stat.diffRatio <= MODULE_DIFF_RATIO_THRESHOLD,
        })) ?? [],
      modulesNeedingFeedback: [],
      round,
      scope: "merged-page" as const,
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
      verifyReportPath: finalVerifyResult.verifyReportPath,
    },
  ];
  const previousModuleFailures =
    previousSession?.result.moduleFailures &&
    typeof previousSession.result.moduleFailures === "object"
      ? previousSession.result.moduleFailures
      : {};
  const mergedModuleFailures = new Map<string, string>(
    Object.entries(previousModuleFailures).filter(([id]) => id !== module.id),
  );
  mergeResult.skippedModules.forEach((skipped) => {
    mergedModuleFailures.set(skipped.id, skipped.error);
  });
  const failedModuleIds = [
    ...new Set([
      ...(previousSession?.result.moduleFailedIds ?? []).filter(
        (id) => id !== module.id,
      ),
      ...mergeResult.skippedModuleIds,
    ]),
  ].sort();
  const moduleFailures = Object.fromEntries(
    failedModuleIds.map((id) => [
      id,
      mergedModuleFailures.get(id) ?? "Module failed in a previous run",
    ]),
  );
  await writeJsonFile(moduleAgentManifestPath, {
    moduleCount: modules.length,
    runs: moduleAgentRuns,
    userFeedback: {
      moduleId: module.id,
      round,
    },
    validation: {
      failedModuleIds,
      maxIterations: round,
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
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
        moduleFailedIds: failedModuleIds,
        moduleFailures,
        moduleMergeManifestPath,
        moduleValidationRuns,
      },
    });
  }

  return {
    failedModuleIds,
    moduleAgentManifestPath,
    moduleAgentRuns,
    moduleValidationRuns,
    moduleMergeManifestPath,
    modulePlanPath,
    scaffoldHtmlPath,
    verifyResult: finalVerifyResult,
  };
}
