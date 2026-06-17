import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { AGENT_REASONING_EFFORTS } from "../../config/agent-reasoning.js";
import { MODULE_DIFF_RATIO_THRESHOLD } from "../../config/runtime.js";
import { normalizeOutputFormat } from "../../core/output-target.js";
import {
  createModuleTextBlocks,
  type ModuleTextBlocksFile,
} from "../../core/module-text-blocks.js";
import type { SvgVerticalModule } from "../../core/svg-vertical-modules/types.js";
import type { ResolvedDesignTarget } from "../../core/utils.js";
import { isRecord, writeJsonFile } from "../../core/utils.js";
import { sessionStore } from "../../session-store.js";
import type { AgentThread } from "../agent-runtime/index.js";
import { mergeModulesIntoHtml, readModulePlan } from "../module-merge.js";
import type { VerifyResult } from "../verify/types.js";
import {
  createComponentLibraryAgentContext,
  createComponentLibraryPlanRef,
} from "./component-library-context.js";
import {
  createComponentAdoptionPlan,
  getComponentAdoptionPlanPath,
} from "./component-adoption-plan.js";
import {
  createAgentUnitThread,
  ModuleOutputIncompleteError,
  runAgentUnit,
} from "./agent-unit.js";
import { buildUserModuleRevisionPrompt } from "../../prompts/module-agent.js";
import { runWithLimit } from "./concurrency.js";
import type { AgentTurnMetrics } from "./agent-turn-types.js";
import { isAbortError, throwIfRunAborted } from "./run-control.js";
import { archiveSessionCheckpoint } from "./checkpoint.js";
import { runVerify } from "./verify-step.js";
import {
  analyzeModuleElements,
} from "./module-semantic-pass.js";
import { writeModuleSemanticPayload } from "./module-semantic-payload.js";
import {
  buildModuleSemanticTextHints,
  createModuleSemanticDraft,
  ensureModuleContextImages,
  ensureModuleReferenceImage,
  readModuleSemanticDocument,
  type ModuleSemanticDocument,
} from "./module-semantic.js";
import {
  createModuleTextStyleHints,
  type ModuleTextStyleHintsFile,
} from "./module-text-style-inference.js";
import {
  verifyModuleLocal,
} from "./module-local-verify.js";
import {
  verifyModuleFrameworkLocal,
} from "./module-framework-local-verify.js";
import { checkFrameworkRenderHealth } from "./render-health-check.js";
import { finalizeModuleManifest } from "../module-merge/finalize-module-manifest.js";
import {
  ensureModuleSvg,
  ensureScaffoldSnapshot,
  getModuleDir,
  getSourceFragmentPath,
  hasCompleteModuleOutput,
  readModuleSnapshot,
  restoreHostModuleArtifacts,
  restoreModuleSnapshot,
  writeFailedModulePlaceholder,
  type ModuleSnapshot,
} from "./module-artifacts.js";


type ModulePipelineV2Input = {
  controller: AbortController;
  design: ResolvedDesignTarget;
  maxParallelModuleAgents: number;
  sessionId: string;
};

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

type ModuleAgentRunRecord = {
  cachedInputTokens?: number;
  durationMs: number;
  endedAt: number;
  error?: string;
  id: string;
  inputTokens: number;
  outputByteSizes?: {
    manifest: number;
    moduleCss: number;
    previewFragmentHtml: number;
    sourceData?: number;
    sourceFragment?: number;
  };
  agentGeneratedAssetCount?: number;
  outputPaths?: {
    manifest: string;
    moduleCss: string;
    moduleSemanticJson?: string;
    moduleSvg: string;
    previewFragmentHtml: string;
    sourceData?: string;
    sourceFragment?: string;
  };
  outputTokens: number;
  promptKind: "initial" | "revision";
  region: SvgVerticalModule["region"];
  round: number;
  startedAt: number;
  status: "completed" | "failed";
  threadId: string;
  turnSummary?: {
    durationMs: number;
    earlyStopReason?: string;
    internalDiffTimeline: Array<{ diffRatio: number; round: number }>;
    metrics?: AgentTurnMetrics;
    totalCommands: number;
    totalInternalRounds: number;
    totalShellCommands?: number;
    verifyCount: number;
  };
  uncachedInputTokens?: number;
};

const getCachedInputTokens = (usage: { cached_input_tokens?: number } | null) =>
  Math.max(0, Number(usage?.cached_input_tokens ?? 0));

const getUncachedInputTokens = (
  usage: { cached_input_tokens?: number; input_tokens: number } | null,
) => {
  const inputTokens = Math.max(0, Number(usage?.input_tokens ?? 0));
  const cachedInputTokens = getCachedInputTokens(usage);
  return Math.max(0, inputTokens - cachedInputTokens);
};

type ModuleValidationStat = {
  diffPixels?: number;
  diffRatio: number;
  failureKind?: ModuleValidationFailureKind;
  id: string;
  maxChannelDelta?: number;
  mergeError?: string;
  passed: boolean;
  renderPngPath?: string;
};

type ModuleValidationFailureKind =
  | "incomplete_output"
  | "merge_failed"
  | "module_framework_failed"
  | "module_input_failed"
  | "module_visual_failed";

const MODULE_VALIDATION_FAILURE_KINDS = new Set<ModuleValidationFailureKind>([
  "incomplete_output",
  "merge_failed",
  "module_framework_failed",
  "module_input_failed",
  "module_visual_failed",
]);

const normalizeModuleFailureKind = (
  value: unknown,
): ModuleValidationFailureKind =>
  typeof value === "string" &&
  MODULE_VALIDATION_FAILURE_KINDS.has(value as ModuleValidationFailureKind)
    ? (value as ModuleValidationFailureKind)
    : "merge_failed";

class ModuleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleInputError";
  }
}

type ModuleValidationRun = {
  draftHtmlPath?: string;
  diffRatio: number;
  failedModuleIds?: string[];
  moduleStats: ModuleValidationStat[];
  round: number;
  scope: "agent-local" | "merged-page";
  threshold: number;
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

const normalizeModules = (
  modulePlan: Awaited<ReturnType<typeof readModulePlan>>,
) =>
  Array.isArray(modulePlan.modules)
    ? (modulePlan.modules as SvgVerticalModule[])
    : (Object.entries(modulePlan.modules ?? {}).map(([id, value]) => ({
        ...(typeof value === "object" && value ? value : {}),
        id,
      })) as SvgVerticalModule[]);

const buildTextBlocksFileFromSemantic = (
  document: ModuleSemanticDocument,
): ModuleTextBlocksFile => ({
  blockCount: document.textBlocks.length,
  blocks: document.textBlocks.map((block) => ({
    bboxIncludesIcon:
      typeof block.bboxIncludesIcon === "boolean"
        ? block.bboxIncludesIcon
        : undefined,
    color: typeof block.color === "string" ? block.color : undefined,
    confidence:
      typeof block.confidence === "number" ? block.confidence : undefined,
    id: block.id,
    kind: typeof block.kind === "string" ? block.kind : undefined,
    lineCount:
      typeof block.lineCount === "number" && Number.isFinite(block.lineCount)
        ? Math.round(block.lineCount)
        : undefined,
    lineRegions: Array.isArray(block.lineRegions) ? block.lineRegions : undefined,
    lines: Array.isArray(block.lines) ? block.lines : undefined,
    region: isRecord(block.region) ? (block.region as ModuleTextBlocksFile["blocks"][number]["region"]) : block.textRegion,
    renderedTextRegion: isRecord(block.renderedTextRegion)
      ? (block.renderedTextRegion as ModuleTextBlocksFile["blocks"][number]["renderedTextRegion"])
      : undefined,
    source: typeof block.source === "string" ? (block.source as "semantic") : undefined,
    sourceBlockId:
      typeof block.sourceBlockId === "string" ? block.sourceBlockId : undefined,
    sourceBlockText:
      typeof block.sourceBlockText === "string" ? block.sourceBlockText : undefined,
    text: block.text,
    textRegion: block.textRegion,
  })),
  coordinateSpace: "local",
  generatedAt: new Date().toISOString(),
  generatedBy: "semantic-text-extract",
  moduleId: document.module.id,
  previewPath: document.sourceImage.path,
  region: document.module.region,
});

const buildTextStyleHintsFileFromSemantic = (
  document: ModuleSemanticDocument,
): ModuleTextStyleHintsFile => {
  const normalizeFit = (value: unknown) => {
    if (!isRecord(value)) {
      return { heightDelta: 0, score: 0, widthDelta: 0 };
    }
    return {
      heightDelta:
        typeof value.heightDelta === "number" ? value.heightDelta : 0,
      score: typeof value.score === "number" ? value.score : 0,
      ...(typeof value.visualDensityDelta === "number"
        ? { visualDensityDelta: value.visualDensityDelta }
        : {}),
      ...(typeof value.visualIou === "number"
        ? { visualIou: value.visualIou }
        : {}),
      widthDelta: typeof value.widthDelta === "number" ? value.widthDelta : 0,
    };
  };
  const rawDocument = document as Record<string, unknown>;
  const textAppearanceHints = Array.isArray(rawDocument["textAppearanceHints"])
    ? rawDocument["textAppearanceHints"].filter(isRecord)
    : [];
  const hintsById = new Map(
    textAppearanceHints.flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : undefined;
      if (!id) return [];
      const declarations = isRecord(item.declarations)
        ? (Object.fromEntries(
            Object.entries(item.declarations).filter(
              ([, value]) => typeof value === "string",
            ),
          ) as Record<string, string>)
        : {};
      return [
        [
          id,
          {
            declarations,
            fit: normalizeFit(item.fit),
            kind: typeof item.kind === "string" ? item.kind : undefined,
            region: isRecord(item.region) ? item.region : undefined,
            text: typeof item.text === "string" ? item.text : undefined,
          },
        ] as const,
      ];
    }),
  );

  const blocks = document.textBlocks.flatMap((block) => {
    const semanticHint = hintsById.get(block.id);
    const declarations: Record<string, string> =
      semanticHint?.declarations ??
      (isRecord(block.styleInference)
        ? (Object.fromEntries(
            Object.entries(block.styleInference).filter(
              ([, value]) => typeof value === "string",
            ),
          ) as Record<string, string>)
        : {});
    if (Object.keys(declarations).length === 0) return [];
    return [
      {
        confidence:
          typeof block.confidence === "number" ? block.confidence : undefined,
        declarations,
        fit: semanticHint?.fit ?? normalizeFit(undefined),
        id: block.id,
        kind:
          semanticHint?.kind ??
          (typeof block.kind === "string" ? block.kind : undefined),
        lineCount:
          typeof block.lineCount === "number" && Number.isFinite(block.lineCount)
            ? Math.round(block.lineCount)
            : undefined,
        lineRegions: Array.isArray(block.lineRegions) ? block.lineRegions : undefined,
        region: block.textRegion,
        text: semanticHint?.text ?? block.text,
      },
    ];
  });

  return {
    blockCount: blocks.length,
    blocks,
    generatedAt: new Date().toISOString(),
    generatedBy: "text-style-inference",
    moduleId: document.module.id,
    previewPath: document.sourceImage.path,
  };
};

const preprocessModuleSemantic = async ({
  design,
  module,
  moduleDir,
  moduleSvgPath,
  sessionId,
}: {
  design: ResolvedDesignTarget;
  module: SvgVerticalModule;
  moduleDir: string;
  moduleSvgPath: string;
  sessionId: string;
}) => {
  const elementAnalysis = await analyzeModuleElements({
    module,
    moduleDir,
    scale: design.scale,
    sessionId,
  });
  const currentSemantic = await readModuleSemanticDocument(moduleDir);
  if (!currentSemantic) {
    throw new Error(`module-semantic.json missing after semantic pass: ${module.id}`);
  }

  const hasCachedTextArtifacts =
    currentSemantic.runtime.completedStages.includes("text-blocks") &&
    currentSemantic.runtime.completedStages.includes("text-style-inference") &&
    currentSemantic.textBlocks.length > 0;

  const semanticTextHints = buildModuleSemanticTextHints(currentSemantic);
  const textBlocksFile = hasCachedTextArtifacts
    ? buildTextBlocksFileFromSemantic(currentSemantic)
    : await createModuleTextBlocks({
        moduleDir,
        moduleId: module.id,
        textHints: semanticTextHints,
        moduleSvgPath,
        region: module.region,
        scale: design.scale,
      });
  const textStyleHintsFile = hasCachedTextArtifacts
    ? buildTextStyleHintsFileFromSemantic(currentSemantic)
    : await createModuleTextStyleHints({
        moduleDir,
        moduleId: module.id,
        scale: design.scale,
        textBlocksFile,
      });

  const moduleSemantic = await writeModuleSemanticPayload({
    allowedAssets: currentSemantic.generatedAssets,
    basePayload: currentSemantic as unknown as Record<string, unknown>,
    elementAnalysis,
    module,
    moduleDir,
    textHints: semanticTextHints,
    moduleTextBlocks: textBlocksFile,
    moduleTextStyleHints: textStyleHintsFile,
    moduleSvgPath,
    scale: design.scale,
  });

  return {
    elementAnalysis,
    moduleSemantic,
    initialAgentGeneratedAssetCount: currentSemantic.generatedAssets.length,
    textBlocksFile,
    textStyleHintsFile,
  };
};

const readAgentGeneratedAssetCount = async (moduleDir: string) =>
  (await readModuleSemanticDocument(moduleDir))?.generatedAssets.length ?? 0;

const SEMANTIC_CONTAINER_TAGS = new Set([
  "a",
  "defs",
  "desc",
  "g",
  "metadata",
  "svg",
  "switch",
  "symbol",
  "title",
]);

const moduleHasDeclaredSourceContent = (module: SvgVerticalModule) =>
  module.sourceContainerIds.length > 0 ||
  module.nodePaths.length > 0 ||
  module.candidateNodeCount > 0;

const semanticNodeCarriesUsableVisual = (
  node: ModuleSemanticDocument["nodes"][number],
) => {
  if (!node.visible) return false;
  const tag = node.tag.trim().toLowerCase();
  if (SEMANTIC_CONTAINER_TAGS.has(tag)) return false;
  if (node.bbox && node.bbox.width > 0 && node.bbox.height > 0) return true;
  if (node.textContent?.trim()) return true;
  return node.semantic.exportDecision !== "skip";
};

const assertModuleSemanticHasUsableInput = ({
  module,
  moduleSemantic,
  textBlockCount,
}: {
  module: SvgVerticalModule;
  moduleSemantic: ModuleSemanticDocument;
  textBlockCount: number;
}) => {
  if (!moduleHasDeclaredSourceContent(module)) return;
  const hasTextBlocks = textBlockCount > 0;
  const hasUsableVisibleNodes = moduleSemantic.nodes.some(
    semanticNodeCarriesUsableVisual,
  );
  if (hasTextBlocks || hasUsableVisibleNodes) return;

  throw new ModuleInputError(
    `module input has source ownership markers but semantic preprocessing produced no usable text blocks or visible source nodes`,
  );
};

const normalizeModuleAgentThreadIds = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, string>;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([moduleId, threadId]) => [
        String(moduleId).trim(),
        typeof threadId === "string" ? threadId.trim() : "",
      ])
      .filter(([moduleId, threadId]) => moduleId && threadId),
  );
};

const readPersistedModuleAgentThreadIds = (sessionId: string) =>
  normalizeModuleAgentThreadIds(
    sessionStore.get(sessionId)?.result.moduleAgentThreadIds,
  );

const persistModuleAgentThreadId = ({
  moduleId,
  sessionId,
  threadId,
}: {
  moduleId: string;
  sessionId: string;
  threadId: string;
}) => {
  const normalizedModuleId = moduleId.trim();
  const normalizedThreadId = threadId.trim();
  if (!normalizedModuleId || !normalizedThreadId) return;
  const current = sessionStore.get(sessionId);
  if (!current) return;
  const nextThreadIds = {
    ...normalizeModuleAgentThreadIds(current.result.moduleAgentThreadIds),
    [normalizedModuleId]: normalizedThreadId,
  };
  sessionStore.update(sessionId, {
    result: {
      ...current.result,
      moduleAgentThreadIds: nextThreadIds,
    },
  });
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
  const baseComponentLibraryContext = await createComponentLibraryAgentContext({
    modulesRootDir,
    session: currentSession,
  });
  const componentLibraryPlanRef = baseComponentLibraryContext
    ? createComponentLibraryPlanRef({
        descriptor: baseComponentLibraryContext.descriptor,
        descriptorPath: baseComponentLibraryContext.descriptorPath,
        sourceDir: baseComponentLibraryContext.sourceDir,
      })
    : undefined;
  const nextModulePlan = {
    ...modulePlan,
    componentLibrary: componentLibraryPlanRef,
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
    modulePlan.sourceEntryPath !== nextModulePlan.sourceEntryPath ||
    JSON.stringify(modulePlan.componentLibrary ?? null) !==
      JSON.stringify(nextModulePlan.componentLibrary ?? null)
  ) {
    modulePlan = {
      ...nextModulePlan,
    };
    await writeJsonFile(modulePlanPath, modulePlan);
  }
  const modules = normalizeModules(modulePlan);

  if (!modules.length) throw new Error("No modules found in module plan");
  const componentLibraryContext = baseComponentLibraryContext
    ? {
        ...baseComponentLibraryContext,
        adoptionPlanPath: getComponentAdoptionPlanPath(modulesRootDir),
      }
    : undefined;
  if (componentLibraryContext) {
    const componentAdoptionPlan = await createComponentAdoptionPlan({
      descriptor: componentLibraryContext.descriptor,
      modules,
      outputPath: componentLibraryContext.adoptionPlanPath,
    });
    const nextModulePlanWithAdoption = {
      ...modulePlan,
      componentAdoptionPlanPath: componentLibraryContext.adoptionPlanPath,
    };
    if (
      modulePlan.componentAdoptionPlanPath !==
      nextModulePlanWithAdoption.componentAdoptionPlanPath
    ) {
      modulePlan = nextModulePlanWithAdoption;
      await writeJsonFile(modulePlanPath, modulePlan);
    }
    const requiredCount = componentAdoptionPlan.modules.filter(
      (item) => item.intent === "required",
    ).length;
    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2] component adoption plan: ${componentLibraryContext.adoptionPlanPath}, requiredModules=${requiredCount}/${componentAdoptionPlan.modules.length}`,
    );
  }
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
  const failedModuleKinds = new Map<string, ModuleValidationFailureKind>();
  const persistedModuleThreadIds = readPersistedModuleAgentThreadIds(sessionId);

  sessionStore.addLog(
    sessionId,
    `[module-pipeline-v2] starting unified module pipeline: modules=${modules.length}, maxParallel=${maxParallelModuleAgents}`,
  );
  if (componentLibraryContext) {
    sessionStore.addLog(
      sessionId,
      `[module-pipeline-v2] component library enabled: ${componentLibraryContext.name} (${componentLibraryContext.id})`,
    );
  }

  const runInitialModuleRound = async ({
    modulesToRun,
  }: {
    modulesToRun: SvgVerticalModule[];
  }) => {
    sessionStore.startWorkflowNode(sessionId, "agent", {
      detail: `正在并行生成 ${modulesToRun.length} 个模块`,
      iteration: 1,
      maxIterations: 1,
    });
    sessionStore.startStep(sessionId, "agent");
    // 串行预热 module-reference.png，避免多个模块并发 capturePage 争抢 browser instance
    for (const module of modulesToRun) {
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
          design,
          module,
          moduleDir,
          moduleSvgPath,
          sessionId,
        });
        const moduleTextBlockCount = textBlocksFile.blockCount;
        const existingThread = moduleThreads.get(module.id);
        const persistedThreadId = persistedModuleThreadIds[module.id];
        const thread =
          existingThread ??
          createAgentUnitThread({
            artifactDir,
            componentLibrarySourceDir: componentLibraryContext?.sourceDir,
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
        try {
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
            modulePlan: modulePlan as any,
            reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
            sessionId,
            controller,
            componentLibraryContext,
            onThreadStarted: (threadId) => {
              persistedModuleThreadIds[module.id] = threadId;
              persistModuleAgentThreadId({
                moduleId: module.id,
                sessionId,
                threadId,
              });
            },
            round: 1,
            thread,
          });
          const agentGeneratedAssetCount =
            await readAgentGeneratedAssetCount(moduleDir);
          moduleAgentRuns.push({
            cachedInputTokens: getCachedInputTokens(result.usage),
            durationMs: result.durationMs,
            endedAt: result.endedAt,
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

  const collectAgentLocalValidation = async () => {
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
            });
          } catch (error) {
            mergeError = error instanceof Error ? error.message : String(error);
            failureKind = "merge_failed";
            failedModules.set(module.id, mergeError);
            failedModuleKinds.set(module.id, failureKind);
          }
        }

        let frameworkVerifyDiffRatio: number | undefined;
        if (!mergeError && hasOutput && outputFormat !== "html" && componentLibraryContext) {
          try {
            const frameworkResult = await verifyModuleFrameworkLocal({
              componentLibraryContext,
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
          diffRatio <= MODULE_DIFF_RATIO_THRESHOLD;
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
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
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

  await runInitialModuleRound({ modulesToRun: modules });
  throwIfRunAborted(controller);

  await collectAgentLocalValidation();
  throwIfRunAborted(controller);

  sessionStore.addLog(
    sessionId,
    "[module-pipeline-v2] restoring best snapshots",
  );
  for (const [moduleId, snapshot] of bestSnapshots) {
    await restoreModuleSnapshot(path.join(modulesRootDir, moduleId), snapshot);
  }

  await restoreHostModuleArtifacts({
    modules,
    modulesRootDir,
  });
  sessionStore.addLog(
    sessionId,
    "[module-pipeline-v2] validating restored module snapshots",
  );
  await runWithLimit({
    items: modules,
    limit: maxParallelModuleAgents,
    signal: controller.signal,
    worker: async (module) => {
      const moduleDir = getModuleDir(modulesRootDir, module);
      const restoredSnapshot = bestSnapshots.has(module.id);
      const preserveExistingInputFailure =
        !restoredSnapshot &&
        failedModuleKinds.get(module.id) === "module_input_failed";
      if (!hasCompleteModuleOutput(moduleDir, outputFormat)) {
        const message = "incomplete module output after restoring best snapshots";
        if (!preserveExistingInputFailure) {
          failedModules.set(module.id, message);
          failedModuleKinds.set(module.id, "incomplete_output");
        }
        sessionStore.addLog(
          sessionId,
          `[module-pipeline-v2:${module.id}] restored snapshot preflight failed: ${message}`,
        );
        return;
      }

      if (
        restoredSnapshot &&
        failedModuleKinds.get(module.id) !== "module_input_failed"
      ) {
        failedModules.delete(module.id);
        failedModuleKinds.delete(module.id);
      }
    },
  });
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

  const finalVerifyResult = await runVerify(
    sessionId,
    design.svgPath,
    artifactDir,
    2,
    true,
    { mode: "full" },
  );
  moduleValidationRuns.push({
    diffRatio: finalVerifyResult.diffRatio,
    failedModuleIds: [...failedModules.keys()].sort(),
    moduleStats: [],
    round: 2,
    scope: "merged-page",
    threshold: MODULE_DIFF_RATIO_THRESHOLD,
  });

  // Framework-only render health check: a vue/react page can compile cleanly
  // yet render blank if the inlined bundle throws at mount time (classic
  // undeclared-`sourceData` symptom). The pixel diff is high but not
  // self-explanatory; this check inspects the actual mount point and surfaces a
  // concrete reason. Skipped for html (no framework mount point).
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
    if (!health.ok) {
      const message = `framework render health check failed: ${health.reason ?? "mount point empty"}`;
      sessionStore.addLog(
        sessionId,
        `[module-pipeline-v2] ${message}`,
      );
      // Surface as a session-level failure so the result is not silently
      // marked completed with a blank page.
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
}

export async function runModuleUserRevision(
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
  const baseComponentLibraryContext = currentSession
    ? await createComponentLibraryAgentContext({
        modulesRootDir,
        session: currentSession,
      })
    : undefined;
  const componentLibraryPlanRef = baseComponentLibraryContext
    ? createComponentLibraryPlanRef({
        descriptor: baseComponentLibraryContext.descriptor,
        descriptorPath: baseComponentLibraryContext.descriptorPath,
        sourceDir: baseComponentLibraryContext.sourceDir,
      })
    : undefined;
  const nextModulePlan = {
    ...modulePlan,
    componentLibrary: componentLibraryPlanRef,
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
    modulePlan.sourceEntryPath !== nextModulePlan.sourceEntryPath ||
    JSON.stringify(modulePlan.componentLibrary ?? null) !==
      JSON.stringify(nextModulePlan.componentLibrary ?? null)
  ) {
    modulePlan = nextModulePlan;
    await writeJsonFile(modulePlanPath, modulePlan);
  }
  const modules = normalizeModules(modulePlan);
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new Error(`模块不存在：${moduleId}`);
  }

  const componentLibraryContext = baseComponentLibraryContext
    ? {
        ...baseComponentLibraryContext,
        adoptionPlanPath: getComponentAdoptionPlanPath(modulesRootDir),
      }
    : undefined;
  if (componentLibraryContext) {
    await createComponentAdoptionPlan({
      descriptor: componentLibraryContext.descriptor,
      modules,
      outputPath: componentLibraryContext.adoptionPlanPath,
    });
    const nextModulePlanWithAdoption = {
      ...modulePlan,
      componentAdoptionPlanPath: componentLibraryContext.adoptionPlanPath,
    };
    if (
      modulePlan.componentAdoptionPlanPath !==
      nextModulePlanWithAdoption.componentAdoptionPlanPath
    ) {
      modulePlan = nextModulePlanWithAdoption;
      await writeJsonFile(modulePlanPath, modulePlan);
    }
  }
  const moduleAgentManifestPath = path.join(
    modulesRootDir,
    "module-agent-manifest.json",
  );
  const moduleDir = getModuleDir(modulesRootDir, module);
  const persistedModuleThreadIds = readPersistedModuleAgentThreadIds(sessionId);
  await mkdir(moduleDir, { recursive: true });

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
  sessionStore.addLog(
    sessionId,
    `[module-user-revision:${module.id}] semantic draft ready: ${moduleSemanticDraft.jsonPath}`,
  );
  const { moduleSemantic } = await preprocessModuleSemantic({
    design,
    module,
    moduleDir,
    moduleSvgPath,
    sessionId,
  });

  const thread = createAgentUnitThread({
    artifactDir,
    componentLibrarySourceDir: componentLibraryContext?.sourceDir,
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
    modulePlan: modulePlan as any,
    reasoningEffort: AGENT_REASONING_EFFORTS.agentUnit,
    sessionId,
    controller,
    componentLibraryContext,
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
    { mode: "full" },
  );
  const moduleValidationRuns = [
    ...((previousSession?.result.moduleValidationRuns ??
      []) as ModuleValidationRun[]),
    {
      diffRatio: finalVerifyResult.diffRatio,
      failedModuleIds,
      moduleStats: [],
      round,
      scope: "merged-page" as const,
      threshold: MODULE_DIFF_RATIO_THRESHOLD,
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
