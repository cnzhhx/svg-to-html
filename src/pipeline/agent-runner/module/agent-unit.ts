import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import type { AgentReasoningEffort } from "../../../config/agent-reasoning.js";
import { MODULE_AGENT_TIMEOUT_MS } from "../../../config/index.js";
import type { ResolvedDesignTarget } from "../../../core/design-resolve.js";
import { sessionStore } from "../../../session-store.js";
import type { AgentThread } from "../../agent-runtime/index.js";
import type { AgentTokenUsage, AgentTurnMetrics } from "../turn/agent-turn-types.js";
import {
  resumeAgentThread,
  startAgentThread,
  threadOptions,
} from "../../llm-client.js";
import { runAgentTurnCore } from "../turn/agent-turn-core.js";
import { throwIfRunAborted } from "../session/run-control.js";
import { verifyModuleLocal } from "./module-local-verify.js";
import { verifyModuleFrameworkLocal } from "./module-framework-local-verify.js";
import {
  compactDocumentForAgent,
  readModuleSemanticDocument,
} from "./module-semantic.js";
import type {
  SvgVerticalModule,
  SvgVerticalModuleReport,
} from "../../../core/svg-vertical-modules/types.js";
import {
  buildAgentUnitPrompt,
  buildAgentUnitFollowupBasePrompt,
  resolveModuleOutputFormat,
  getSourceFragmentFileName,
} from "../../../prompts/module-agent.js";
import { sanitizeModuleOutputFiles } from "./module-output-sanitize.js";

type AgentUnitInput = {
  module: SvgVerticalModule;
  moduleSvgPath: string; // 裁切后的模块 SVG（仅用于本地渲染/CLI 工具，agent 禁止直接读取）
  originalSvgPath: string; // 原始完整 SVG（用于参考）
  design: ResolvedDesignTarget;
  workingDir: string; // 该模块的独立工作目录 modules/<id>/
  artifactDir: string;
  modulePlan: SvgVerticalModuleReport;
  reasoningEffort: AgentReasoningEffort;
  sessionId: string;
  controller: AbortController;
  revisionPrompt?: string; // 可选的后续修复 prompt
  onThreadStarted?: (threadId: string) => void;
  round?: number;
  thread?: AgentThread;
};

type AgentUnitThreadInput = {
  artifactDir: string;
  design: ResolvedDesignTarget;
  originalSvgPath: string;
  reasoningEffort: AgentReasoningEffort;
  threadId?: string;
  workingDir: string;
};

type AgentUnitResult = {
  success: boolean;
  durationMs: number;
  endedAt: number;
  finalDiffRatio?: number;
  revisionRounds: number;
  outputByteSizes: {
    manifest: number;
    moduleCss: number;
    previewFragmentHtml: number;
    sourceData?: number;
    sourceFragment?: number;
  };
  threadId: string;
  promptKind: "initial" | "revision";
  round: number;
  startedAt: number;
  turnSummary: {
    durationMs: number;
    earlyStopReason?: string;
    internalDiffTimeline: Array<{ diffRatio: number; round: number }>;
    metrics?: AgentTurnMetrics;
    totalCommands: number;
    totalInternalRounds: number;
    totalShellCommands?: number;
    verifyCount: number;
    rollbackCount?: number;
    rollbackReasons?: string[];
  };
  usage: AgentTokenUsage | null;
  outputFiles: {
    manifest: string;
    moduleCss: string;
    previewFragmentHtml: string;
    sourceData?: string;
    sourceFragment?: string;
  };
  outputPaths: {
    manifest: string;
    moduleCss: string;
    moduleSvg: string;
    previewFragmentHtml: string;
    sourceData?: string;
    sourceFragment?: string;
  };
};

type ModuleOutputIncompleteDiagnostics = {
  durationMs: number;
  endedAt: number;
  finalResponseChars: number;
  hasCompletedAgentMessage: boolean;
  promptKind: AgentUnitResult["promptKind"];
  round: number;
  startedAt: number;
  threadId: string;
  turnSummary: AgentUnitResult["turnSummary"];
  usage: AgentTokenUsage | null;
};

type AgentTurnForDiffResolution = Awaited<ReturnType<typeof runAgentTurnCore>>;

type PostSanitizeVerifySummary = {
  diffRatio: number;
  localDiffRatio: number;
  frameworkDiffRatio?: number;
  round: number;
  verifyCount: number;
};

class ModuleOutputIncompleteError extends Error {
  diagnostics?: ModuleOutputIncompleteDiagnostics;
  missingFiles: string[];

  constructor(moduleId: string, missingFiles: string[]) {
    super(
      `${moduleId} incomplete module output: missing ${missingFiles.join(", ")}`,
    );
    this.name = "ModuleOutputIncompleteError";
    this.missingFiles = missingFiles;
  }

  attachDiagnostics(diagnostics: ModuleOutputIncompleteDiagnostics) {
    this.diagnostics = diagnostics;
    return this;
  }
}

const readFileSize = async (filePath: string) => (await stat(filePath)).size;

const isMissingOrEmptyFile = async (filePath: string) => {
  try {
    return (await stat(filePath)).size === 0;
  } catch {
    return true;
  }
};

const shouldWriteInitialManifest = async (manifestPath: string) => {
  if (await isMissingOrEmptyFile(manifestPath)) return true;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      status?: unknown;
    };
    return parsed.status === "failed";
  } catch {
    return false;
  }
};

const buildInitialManifestTemplate = (module: SvgVerticalModule) =>
  `${JSON.stringify(
    {
      moduleId: module.id,
      kind: module.kind,
      fragments: ["preview.fragment.html"],
      styles: ["module.css"],
    },
    null,
    2,
  )}\n`;

const buildInitialPreviewTemplate = (module: SvgVerticalModule) =>
  `<div class="${module.id}" data-module-id="${module.id}"></div>\n`;

const buildInitialSourceFragmentTemplate = (
  module: SvgVerticalModule,
  outputFormat: ReturnType<typeof resolveModuleOutputFormat>,
) =>
  outputFormat === "react"
    ? `<div className="${module.id}" data-module-id="${module.id}"></div>\n`
    : buildInitialPreviewTemplate(module);

const buildInitialCssTemplate = (module: SvgVerticalModule) =>
  `.${module.id} {\n  position: relative;\n  width: ${Math.round(module.region.width)}px;\n  height: ${Math.round(module.region.height)}px;\n  overflow: hidden;\n}\n`;

const ensureInitialModuleOutputTemplate = async ({
  manifestPath,
  module,
  moduleCssPath,
  outputFormat,
  previewFragmentHtmlPath,
  sourceFragmentPath,
}: {
  manifestPath: string;
  module: SvgVerticalModule;
  moduleCssPath: string;
  outputFormat: ReturnType<typeof resolveModuleOutputFormat>;
  previewFragmentHtmlPath: string;
  sourceFragmentPath: string;
}) => {
  await mkdir(path.dirname(previewFragmentHtmlPath), { recursive: true });
  const writes: Array<Promise<void>> = [];
  const writtenFiles: string[] = [];

  if (await isMissingOrEmptyFile(previewFragmentHtmlPath)) {
    writes.push(
      writeFile(
        previewFragmentHtmlPath,
        buildInitialPreviewTemplate(module),
        "utf8",
      ),
    );
    writtenFiles.push("preview.fragment.html");
  }
  if (await isMissingOrEmptyFile(moduleCssPath)) {
    writes.push(writeFile(moduleCssPath, buildInitialCssTemplate(module), "utf8"));
    writtenFiles.push("module.css");
  }
  if (await shouldWriteInitialManifest(manifestPath)) {
    writes.push(writeFile(manifestPath, buildInitialManifestTemplate(module), "utf8"));
    writtenFiles.push("manifest.json");
  }
  if (
    outputFormat !== "html" &&
    (await isMissingOrEmptyFile(sourceFragmentPath))
  ) {
    writes.push(
      writeFile(
        sourceFragmentPath,
        buildInitialSourceFragmentTemplate(module, outputFormat),
        "utf8",
      ),
    );
    writtenFiles.push(getSourceFragmentFileName(outputFormat));
  }

  await Promise.all(writes);
  return writtenFiles;
};

const ensureRequiredOutputFiles = async ({
  manifestPath,
  module,
  moduleCssPath,
  outputFormat,
  previewFragmentHtmlPath,
  sourceFragmentPath,
}: {
  manifestPath: string;
  module: SvgVerticalModule;
  moduleCssPath: string;
  outputFormat: ReturnType<typeof resolveModuleOutputFormat>;
  previewFragmentHtmlPath: string;
  sourceFragmentPath: string;
}) => {
  const requiredFiles = [
    { label: "preview.fragment.html", path: previewFragmentHtmlPath },
    { label: "module.css", path: moduleCssPath },
    { label: "manifest.json", path: manifestPath },
    ...(outputFormat === "html"
      ? []
      : [
          {
            label: getSourceFragmentFileName(outputFormat),
            path: sourceFragmentPath,
          },
        ]),
  ];
  const missingCoreFiles = requiredFiles
    .filter((file) => !existsSync(file.path))
    .map((file) => file.label);
  if (missingCoreFiles.length) {
    throw new ModuleOutputIncompleteError(module.id, missingCoreFiles);
  }
};

const createAgentUnitThread = ({
  artifactDir,
  design,
  originalSvgPath,
  reasoningEffort,
  threadId,
  workingDir,
}: AgentUnitThreadInput) => {
  const options = {
    ...threadOptions,
    // 设计还原是纯本地任务：禁用网络/网页搜索，收紧工具空间，避免无谓的 webfetch/websearch step。
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    workingDirectory: workingDir,
    additionalDirectories: [
      path.join(path.dirname(originalSvgPath), "assets"),
    ].filter(
      (dir): dir is string => typeof dir === "string" && existsSync(dir),
    ),
    deviceScaleFactor: design.scale,
    modelReasoningEffort: reasoningEffort,
    runtimeTraceDir: path.join(
      artifactDir,
      "runtime-traces",
      path.basename(workingDir),
    ),
    runtimeTraceLabel: path.basename(workingDir),
  };
  return threadId
    ? resumeAgentThread(threadId, options, {
        modelRole: "moduleAgent",
        source: "module-agent",
      })
    : startAgentThread(options, {
        modelRole: "moduleAgent",
        source: "module-agent",
      });
};

/**
 * 构建注入到首次 prompt 末尾的模块上下文。
 * 将 compacted semantic JSON + 当前输出文件内容 + 资产列表一次性附加，
 * 省去 agent 开头 4-8 次 read 调用。
 */
const buildInjectedModuleContext = async (
  workingDir: string,
): Promise<string> => {
  const safeRead = async (filePath: string): Promise<string | null> => {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  };
  const safeReaddir = async (dirPath: string): Promise<string[]> => {
    try {
      return (await readdir(dirPath)).filter((e) => !e.startsWith("."));
    } catch {
      return [];
    }
  };

  // Read and compact semantic JSON
  const semanticDoc = await readModuleSemanticDocument(workingDir);
  let semanticSection = "";
  if (semanticDoc) {
    const compacted = compactDocumentForAgent(semanticDoc);
    semanticSection = `### module-semantic.json（精简版，已预加载）
\`\`\`json
${JSON.stringify(compacted, null, 2)}
\`\`\``;
  }

  // Read output files
  const outputSections: string[] = [];
  const filesToRead = [
    "preview.fragment.html",
    "module.css",
    "manifest.json",
  ] as const;
  for (const filename of filesToRead) {
    const content = await safeRead(path.join(workingDir, filename));
    if (content !== null) {
      outputSections.push(`### ${filename}
\`\`\`
${content}
\`\`\``);
    }
  }

  // Asset listing
  const assetFiles = await safeReaddir(path.join(workingDir, "assets"));
  const assetSection = assetFiles.length > 0
    ? `### assets/ 目录\n${assetFiles.join(", ")}`
    : "### assets/ 目录\n（空）";

  return `
---
## 模块当前状态（已预加载，首次无需再 read 这些文件）

${semanticSection}

${outputSections.join("\n\n")}

${assetSection}
---`;
};

const resolveAgentFinalDiffRatio = ({
  postSanitizeVerify,
  turn,
}: {
  postSanitizeVerify?: PostSanitizeVerifySummary;
  turn: AgentTurnForDiffResolution;
}) => {
  if (postSanitizeVerify) return postSanitizeVerify.diffRatio;
  if (turn.turnSummary.verifyUsage.bestDiffRatio !== undefined) {
    return turn.turnSummary.verifyUsage.bestDiffRatio;
  }
  const verifyDiffRatios = turn.turnSummary.internalRounds
    .map((internalRound) => internalRound.diffRatio)
    .filter((diffRatio): diffRatio is number => diffRatio !== undefined);
  if (!verifyDiffRatios.length) return undefined;
  return Math.min(...verifyDiffRatios);
};

const verifyAfterSanitizeIfNeeded = async ({
  controller,
  design,
  module,
  modulePlan,
  moduleSvgPath,
  outputFormat,
  round,
  sessionId,
  turn,
  workingDir,
}: {
  controller: AbortController;
  design: ResolvedDesignTarget;
  module: SvgVerticalModule;
  modulePlan: SvgVerticalModuleReport;
  moduleSvgPath: string;
  outputFormat: ReturnType<typeof resolveModuleOutputFormat>;
  round: number;
  sessionId: string;
  turn: AgentTurnForDiffResolution;
  workingDir: string;
}): Promise<PostSanitizeVerifySummary | undefined> => {
  if (turn.turnSummary.verifyUsage.verifyCount <= 0) return undefined;

  const verifyRound = Math.max(0, round + turn.turnSummary.verifyUsage.verifyCount);
  const localVerify = await verifyModuleLocal({
    module,
    moduleDir: workingDir,
    modulePlan,
    modulePlanPath: path.join(path.dirname(workingDir), "module-plan.json"),
    moduleSvgPath,
    onProgress: (message) =>
      sessionStore.addLog(
        sessionId,
        `[agent-unit:${module.id}] post-sanitize verify: ${message}`,
      ),
    round: verifyRound,
    scale: design.scale,
    scaffoldHtmlPath: path.join(path.dirname(workingDir), "modules-scaffold.html"),
    signal: controller.signal,
  });
  throwIfRunAborted(controller);

  let finalDiffRatio = localVerify.diffRatio;
  let verifyCount = 1;
  sessionStore.addLog(
    sessionId,
    `[agent-unit:${module.id}] post-sanitize local diffRatio=${(localVerify.diffRatio * 100).toFixed(2)}%`,
  );

  let frameworkDiffRatio: number | undefined;
  if (outputFormat !== "html") {
    const frameworkVerify = await verifyModuleFrameworkLocal({
      design,
      module,
      moduleDir: workingDir,
      moduleSvgPath,
      onProgress: (message) =>
        sessionStore.addLog(
          sessionId,
          `[agent-unit:${module.id}] post-sanitize framework verify: ${message}`,
        ),
      outputFormat,
      round: verifyRound,
      signal: controller.signal,
    });
    throwIfRunAborted(controller);
    if (frameworkVerify) {
      verifyCount += 1;
      frameworkDiffRatio = frameworkVerify.diffRatio;
      finalDiffRatio = Math.max(finalDiffRatio, frameworkVerify.diffRatio);
      sessionStore.addLog(
        sessionId,
        `[agent-unit:${module.id}] post-sanitize framework diffRatio=${(frameworkVerify.diffRatio * 100).toFixed(2)}%`,
      );
    }
  }

  return {
    diffRatio: finalDiffRatio,
    frameworkDiffRatio,
    localDiffRatio: localVerify.diffRatio,
    round: verifyRound,
    verifyCount,
  };
};

/**
 * 统一的 agent 执行单元
 *
 * 为单个模块执行一次 agent turn（初始生成或后续修复）。
 * 后续修复由上层（module-pipeline-v2）按用户指令触发。
 *
 * 核心能力（继承自 runAgentTurnCore）：
 * - Thread 管理（可复用已有 thread）
 * - Stall 检测 + early stop
 * - Archive checkpoint
 */
export async function runAgentUnit(
  input: AgentUnitInput,
): Promise<AgentUnitResult> {
  const {
    module,
    moduleSvgPath,
    originalSvgPath,
    design,
    workingDir,
    artifactDir,
    modulePlan,
    reasoningEffort,
    sessionId,
    controller,
    revisionPrompt,
    onThreadStarted,
    round = 1,
    thread: inputThread,
  } = input;

  const startedAt = Date.now();
  const promptKind = revisionPrompt ? "revision" : "initial";
  const revisionRounds = revisionPrompt ? 1 : 0;
  const outputFormat = resolveModuleOutputFormat({ design, modulePlan });

  // 输出文件路径（提前声明，用于 rollback 备份）
  const previewFragmentHtmlPath = path.join(
    workingDir,
    "preview.fragment.html",
  );
  const moduleCssPath = path.join(workingDir, "module.css");
  const sourceFragmentPath =
    outputFormat === "html"
      ? previewFragmentHtmlPath
      : path.join(workingDir, getSourceFragmentFileName(outputFormat));
  const sourceDataPath = path.join(workingDir, "source-data.json");
  const manifestPath = path.join(workingDir, "manifest.json");

  const scaffoldedFiles = await ensureInitialModuleOutputTemplate({
    manifestPath,
    module,
    moduleCssPath,
    outputFormat,
    previewFragmentHtmlPath,
    sourceFragmentPath,
  });
  if (scaffoldedFiles.length) {
    sessionStore.addLog(
      sessionId,
      `[agent-unit:${module.id}] scaffolded initial output template: ${scaffoldedFiles.join(", ")}`,
    );
  }

  // 构造 prompt（初始或后续修复）
  let prompt: string;
  if (revisionPrompt) {
    prompt = `${buildAgentUnitFollowupBasePrompt({
      module,
      design,
      modulePlan,
      workingDir,
      round,
    })}\n\n${revisionPrompt}`;
  } else {
    const basePrompt = buildAgentUnitPrompt({
      module,
      design,
      modulePlan,
      workingDir,
    });
    // 首次 prompt：注入 compacted semantic + output files，省去 4-8 次 read
    const injectedContext = await buildInjectedModuleContext(workingDir);
    prompt = `${basePrompt}\n${injectedContext}`;
  }
  const thread =
    inputThread ??
    createAgentUnitThread({
      artifactDir,
      design,
      originalSvgPath,
      reasoningEffort,
      workingDir,
    });

  sessionStore.addLog(
    sessionId,
    `[agent-unit:${module.id}] starting with thread ${thread.id ?? "unknown"}, workingDir=${path.relative(process.cwd(), workingDir)}, input=prompt-only`,
  );

  const turn = await runAgentTurnCore({
    thread,
    input: prompt,
    round,
    sessionId,
    controller,
    eventSourceLabel: module.id,
    moduleId: module.id,
    onThreadStarted,
    updateSessionThread: false,
    moduleTimeoutMs: MODULE_AGENT_TIMEOUT_MS,
    rollbackBackupRoot: workingDir,
    rollbackFiles: [
      previewFragmentHtmlPath,
      moduleCssPath,
      manifestPath,
      ...(outputFormat === "html" ? [] : [sourceFragmentPath, sourceDataPath]),
    ],
  });

  sessionStore.addLog(
    sessionId,
    `[agent-unit:${module.id}] turn completed: ${turn.turnSummary.totalCommands} commands, ${(turn.turnSummary.durationMs / 1000).toFixed(1)}s`,
  );

  try {
    await ensureRequiredOutputFiles({
      manifestPath,
      module,
      moduleCssPath,
      outputFormat,
      previewFragmentHtmlPath,
      sourceFragmentPath,
    });
  } catch (error) {
    if (error instanceof ModuleOutputIncompleteError) {
      const endedAt = Date.now();
      throw error.attachDiagnostics({
        durationMs: endedAt - startedAt,
        endedAt,
        finalResponseChars: turn.finalResponse.length,
        hasCompletedAgentMessage: turn.hasCompletedAgentMessage,
        promptKind,
        round,
        startedAt,
        threadId: thread.id ?? "unknown",
        turnSummary: {
          durationMs: turn.turnSummary.durationMs,
          earlyStopReason: turn.turnSummary.earlyStopReason,
          internalDiffTimeline: turn.turnSummary.internalRounds
            .filter((internalRound) => internalRound.diffRatio !== undefined)
            .map((internalRound) => ({
              diffRatio: internalRound.diffRatio!,
              round: internalRound.roundNumber,
            })),
          metrics: turn.turnSummary.metrics,
          totalCommands: turn.turnSummary.totalCommands,
          totalInternalRounds: turn.turnSummary.totalInternalRounds,
          totalShellCommands: turn.turnSummary.totalShellCommands,
          verifyCount: turn.turnSummary.verifyUsage.verifyCount,
          rollbackCount: turn.turnSummary.verifyUsage.rollbackCount,
          rollbackReasons: turn.turnSummary.verifyUsage.rollbackReasons,
        },
        usage: turn.usage,
      });
    }
    throw error;
  }

  throwIfRunAborted(controller);
  const sanitizeResult = await sanitizeModuleOutputFiles({
    module,
    moduleDir: workingDir,
  });
  throwIfRunAborted(controller);
  let postSanitizeVerify: PostSanitizeVerifySummary | undefined;
  if (sanitizeResult.changed) {
    sessionStore.addLog(
      sessionId,
      `[agent-unit:${module.id}] sanitized module output: ${sanitizeResult.reason ?? "normalized root styles"}`,
    );
    postSanitizeVerify = await verifyAfterSanitizeIfNeeded({
      controller,
      design,
      module,
      modulePlan,
      moduleSvgPath,
      outputFormat,
      round,
      sessionId,
      turn,
      workingDir,
    });
  }

  throwIfRunAborted(controller);
  const finalDiffRatio = resolveAgentFinalDiffRatio({
    postSanitizeVerify,
    turn,
  });
  // 读取输出文件
  const [
    previewFragmentHtml,
    moduleCss,
    sourceFragment,
    sourceData,
    manifest,
  ] = await Promise.all([
    readFile(previewFragmentHtmlPath, "utf8"),
    readFile(moduleCssPath, "utf8"),
    outputFormat === "html"
      ? readFile(previewFragmentHtmlPath, "utf8")
      : readFile(sourceFragmentPath, "utf8"),
    outputFormat === "html"
      ? Promise.resolve(undefined)
      : readFile(sourceDataPath, "utf8").catch(() => undefined),
    readFile(manifestPath, "utf8"),
  ]);
  const [
    previewFragmentHtmlSize,
    moduleCssSize,
    sourceFragmentSize,
    sourceDataSize,
    manifestSize,
  ] = await Promise.all([
    readFileSize(previewFragmentHtmlPath),
    readFileSize(moduleCssPath),
    outputFormat === "html"
      ? Promise.resolve(undefined)
      : readFileSize(sourceFragmentPath),
    outputFormat === "html"
      ? Promise.resolve(undefined)
      : readFileSize(sourceDataPath).catch(() => undefined),
    readFileSize(manifestPath),
  ]);
  const endedAt = Date.now();

  return {
    success: true,
    durationMs: endedAt - startedAt,
    endedAt,
    finalDiffRatio,
    revisionRounds,
    outputByteSizes: {
      manifest: manifestSize,
      moduleCss: moduleCssSize,
      previewFragmentHtml: previewFragmentHtmlSize,
      ...(sourceDataSize === undefined ? {} : { sourceData: sourceDataSize }),
      ...(sourceFragmentSize === undefined
        ? {}
        : { sourceFragment: sourceFragmentSize }),
    },
    threadId: thread.id ?? "unknown",
    promptKind,
    round,
    startedAt,
    turnSummary: {
      durationMs: turn.turnSummary.durationMs,
      earlyStopReason: turn.turnSummary.earlyStopReason,
      internalDiffTimeline: turn.turnSummary.internalRounds
        .filter((internalRound) => internalRound.diffRatio !== undefined)
        .map((internalRound) => ({
          diffRatio: internalRound.diffRatio!,
          round: internalRound.roundNumber,
        }))
        .concat(
          postSanitizeVerify
            ? [
                {
                  diffRatio: postSanitizeVerify.diffRatio,
                  round: postSanitizeVerify.round,
                },
              ]
            : [],
        ),
      metrics: turn.turnSummary.metrics,
      totalCommands: turn.turnSummary.totalCommands,
      totalInternalRounds: turn.turnSummary.totalInternalRounds,
      totalShellCommands: turn.turnSummary.totalShellCommands,
      verifyCount:
        turn.turnSummary.verifyUsage.verifyCount +
        (postSanitizeVerify?.verifyCount ?? 0),
      rollbackCount: turn.turnSummary.verifyUsage.rollbackCount,
      rollbackReasons: turn.turnSummary.verifyUsage.rollbackReasons,
    },
    usage: turn.usage,
    outputFiles: {
      manifest,
      moduleCss,
      previewFragmentHtml,
      ...(sourceData === undefined ? {} : { sourceData }),
      ...(outputFormat === "html" ? {} : { sourceFragment }),
    },
    outputPaths: {
      manifest: manifestPath,
      moduleCss: moduleCssPath,
      moduleSvg: moduleSvgPath,
      previewFragmentHtml: previewFragmentHtmlPath,
      ...(outputFormat === "html" ? {} : { sourceData: sourceDataPath }),
      ...(outputFormat === "html"
        ? {}
        : { sourceFragment: sourceFragmentPath }),
    },
  };
}


export { ModuleOutputIncompleteError, createAgentUnitThread };
