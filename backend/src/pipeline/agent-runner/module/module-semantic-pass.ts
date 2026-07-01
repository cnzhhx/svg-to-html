import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getPngRasterScaleMultiplier,
  getVisionTextTimeoutMs,
} from "../../../config/index.js";
import { capturePage, launchEdge } from "../../../core/cdp.js";
import { exportSvgNodeAsset } from "../../../cli/export-svg-node-asset.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { Box } from "../../../core/geometry.js";
import { runVisionLlm } from "../../llm-client.js";
import { sessionStore } from "../../../session-store.js";
import { Semaphore } from "../queue/concurrency.js";
import {
  writeModuleSemanticDocument,
  readModuleSemanticDocument,
  readString,
  type ModuleSemanticAnalysisSheet,
  type ModuleSemanticDocument,
  type ModuleSemanticNode,
  type ModuleSemanticNodeSemantic,
  type ModuleSemanticTextBlock,
} from "./module-semantic.js";
import {
  buildVisionPrompt,
  type SemanticProbeSheetCell,
} from "../../../prompts/semantic.js";
import {
  readPaintLuminance,
  textColorFromNodePaint,
} from "./module-semantic-paint.js";
import {
  normalizeVisionNodeSemantic,
  stripJsonMarkdown,
  type VisionNodeSemantic,
} from "./module-semantic-vision-normalize.js";
import {
  applyTextEffectLayerSemantics,
  detectTextEffectLayerGroups,
} from "./module-semantic-text-effects.js";
import {
  deduplicateProbeNodes,
  hasIntrinsicVisualPresence,
  toProbeNode,
  type SemanticProbeNode,
} from "./module-semantic-probes.js";
import {
  readPngAlphaStats,
  type PngAlphaStats,
} from "./module-semantic-png.js";
import { buildDeterministicSemantic } from "./module-semantic-deterministic.js";
import { deduplicateProbeArtifactsByPixels } from "./module-semantic-probe-pixel-dedup.js";

type ElementClassification =
  | "atomic-visual-text"
  | "background"
  | "decoration"
  | "icon"
  | "image"
  | "plain-text"
  | "skip";

type AnalyzedElement = {
  bbox: [number, number, number, number];
  classification: ElementClassification;
  containsText?: boolean;
  dLength: number;
  exportDecision: "export" | "skip";
  fill: string;
  hasImage: boolean;
  index: number;
  matchedTextBlockIds?: string[];
  matchedTextBlocks?: string[];
  nodeId: string;
  nodePath: string;
  semanticText?: string;
  sourceNodeSelector?: string;
  tag: string;
  visionReason?: string;
};

type ModuleElementAnalysisResult = {
  analysisVersion: number;
  elements: AnalyzedElement[];
  skipIndices: number[];
};

type ProbeArtifact = {
  node: SemanticProbeNode;
  outputPath: string;
  previewBackground: ProbePreviewBackground;
};

type ProbeImageResult = {
  artifacts: ProbeArtifact[];
  transparentNodeIds: string[];
};

type ProbePreviewBackground = "dark" | "light";

const MODULE_ELEMENT_ANALYSIS_VERSION = 3;
const ANALYSIS_BATCH_SIZES = [6, 4, 2] as const;
const PROBE_PADDING = 0;
const SHEET_OUTER_PADDING = 16;
const SHEET_GAP = 12;
const CELL_INNER_PADDING = 8;
const SHEET_META_HEIGHT = 18;
const SHEET_META_GAP = 8;
const SHEET_CELL_MIN_WIDTH = 104;
const PREVIEW_SCALE = 2;
const SEMANTIC_PROBE_SCALE_MULTIPLIER = 2;
const RECHECK_BATCH_SIZE = 4;
const MAX_TEXT_RECHECK_CANDIDATES = 12;
const STANDALONE_PATH_DATA_LENGTH_MIN = 50_000;

const toBboxArray = (box: Box): [number, number, number, number] => [
  box.x,
  box.y,
  box.width,
  box.height,
];

type SheetRenderVariant = "primary" | "recheck";

type SheetCellLayout = SemanticProbeSheetCell & {
  frameHeight: number;
  frameWidth: number;
  height: number;
  outputPath: string;
  previewBackground: ProbePreviewBackground;
  previewHeight: number;
  previewWidth: number;
  width: number;
  x: number;
  y: number;
};

const getProbeFrameSize = (probe: ProbeArtifact) => {
  const bbox = probe.node.bbox;
  return {
    frameHeight: Math.max(1, Math.ceil(bbox.height + PROBE_PADDING * 2)),
    frameWidth: Math.max(1, Math.ceil(bbox.width + PROBE_PADDING * 2)),
  };
};

const buildSheetHtml = ({
  probes,
  variant = "primary",
}: {
  probes: ProbeArtifact[];
  variant?: SheetRenderVariant;
}) => {
  const cells = probes.map((probe, originalIndex) => {
    const { frameHeight, frameWidth } = getProbeFrameSize(probe);
    const previewWidth = Math.max(1, Math.round(frameWidth * PREVIEW_SCALE));
    const previewHeight = Math.max(1, Math.round(frameHeight * PREVIEW_SCALE));
    return {
      frameHeight,
      frameWidth,
      height:
        previewHeight +
        CELL_INNER_PADDING * 2 +
        SHEET_META_HEIGHT +
        SHEET_META_GAP,
      id: probe.node.id,
      previewBackground: probe.previewBackground,
      previewHeight,
      previewWidth,
      originalIndex,
      outputPath: probe.outputPath,
      width: Math.max(
        SHEET_CELL_MIN_WIDTH,
        previewWidth + CELL_INNER_PADDING * 2,
      ),
    };
  });
  const targetColumns =
    variant === "recheck"
      ? Math.max(1, Math.min(2, cells.length))
      : Math.max(1, Math.min(cells.length <= 4 ? 2 : 3, cells.length));
  const rows: Array<{ cells: (typeof cells)[number][]; height: number; width: number }> = [];
  for (let index = 0; index < cells.length; index += targetColumns) {
    const rowCells = cells.slice(index, index + targetColumns);
    rows.push({
      cells: rowCells,
      height: rowCells.reduce((max, cell) => Math.max(max, cell.height), 0),
      width:
        rowCells.reduce((sum, cell) => sum + cell.width, 0) +
        Math.max(0, rowCells.length - 1) * SHEET_GAP,
    });
  }

  const positionedCells: SheetCellLayout[] = [];
  let currentY = SHEET_OUTER_PADDING;
  rows.forEach((row, rowIndex) => {
    let currentX = SHEET_OUTER_PADDING;
    row.cells.forEach((cell, columnIndex) => {
      positionedCells.push({
        column: columnIndex,
        frameHeight: cell.frameHeight,
        frameWidth: cell.frameWidth,
        height: cell.height,
        id: cell.id,
        ordinal: cell.originalIndex + 1,
        outputPath: cell.outputPath,
        previewBackground: cell.previewBackground,
        previewHeight: cell.previewHeight,
        previewWidth: cell.previewWidth,
        row: rowIndex,
        width: cell.width,
        x: currentX,
        y: currentY,
      });
      currentX += cell.width + SHEET_GAP;
    });
    currentY += row.height + SHEET_GAP;
  });

  const columns = rows.reduce(
    (max, row) => Math.max(max, row.cells.length),
    0,
  );
  const sheetWidth =
    SHEET_OUTER_PADDING * 2 +
    rows.reduce((max, row) => Math.max(max, row.width), 0);
  const sheetHeight =
    SHEET_OUTER_PADDING * 2 +
    rows.reduce((sum, row) => sum + row.height, 0) +
    Math.max(0, rows.length - 1) * SHEET_GAP;
  const averageThumbSize = positionedCells.length
    ? Math.round(
        positionedCells.reduce(
          (sum, cell) => sum + Math.min(cell.frameWidth, cell.frameHeight),
          0,
        ) / positionedCells.length,
      )
    : 0;

  return {
    cellPlacements: positionedCells,
    columns,
    html: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0;
        width: ${sheetWidth}px;
        height: ${sheetHeight}px;
        overflow: hidden;
        background: #eef2f7;
      }
      body {
        font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
      }
      .sheet {
        position: relative;
        width: ${sheetWidth}px;
        height: ${sheetHeight}px;
      }
      .cell {
        position: absolute;
        padding: ${CELL_INNER_PADDING}px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
      }
      .meta {
        height: ${SHEET_META_HEIGHT}px;
        margin-bottom: ${SHEET_META_GAP}px;
        display: flex;
        align-items: center;
        gap: 6px;
        font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #64748b;
      }
      .meta-index {
        min-width: 20px;
        height: 18px;
        padding: 0 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.9);
        color: #0f172a;
      }
      .meta-id {
        opacity: 0.78;
      }
      .frame {
        position: relative;
        display: flex;
        width: var(--frame-width);
        height: var(--frame-height);
      }
      .preview {
        position: relative;
        width: var(--preview-width);
        height: var(--preview-height);
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        overflow: hidden;
        box-sizing: border-box;
      }
      .preview--light {
        background:
          linear-gradient(45deg, #eff3f8 25%, transparent 25%, transparent 75%, #eff3f8 75%, #eff3f8),
          linear-gradient(45deg, #eff3f8 25%, transparent 25%, transparent 75%, #eff3f8 75%, #eff3f8);
        background-color: #ffffff;
        background-position: 0 0, 6px 6px;
        background-size: 12px 12px;
      }
      .preview--dark {
        border-color: #475569;
        background:
          linear-gradient(45deg, rgba(148, 163, 184, 0.18) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.18) 75%, rgba(148, 163, 184, 0.18)),
          linear-gradient(45deg, rgba(148, 163, 184, 0.18) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.18) 75%, rgba(148, 163, 184, 0.18));
        background-color: #334155;
        background-position: 0 0, 6px 6px;
        background-size: 12px 12px;
      }
      .preview img {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        filter:
          drop-shadow(0 0 0.8px rgba(15, 23, 42, 0.82))
          drop-shadow(0 0 2px rgba(255, 255, 255, 0.28));
      }
    </style>
  </head>
  <body>
    <main class="sheet">
      ${positionedCells
        .map(
          (cell) => `<section class="cell" style="left:${cell.x}px;top:${cell.y}px;width:${cell.width}px;height:${cell.height}px;--frame-width:${cell.previewWidth}px;--frame-height:${cell.previewHeight}px;--preview-width:${cell.previewWidth}px;--preview-height:${cell.previewHeight}px;">
        <div class="meta"><span class="meta-index">#${cell.ordinal}</span><span class="meta-id">${cell.id}</span></div>
        <div class="frame">
          <div class="preview preview--${cell.previewBackground}"><img src="${pathToFileURL(cell.outputPath).href}" alt="${cell.id}" /></div>
        </div>
      </section>`,
        )
        .join("")}
    </main>
    <script>
      const images = Array.from(document.images);
      const settle = () => {
        setTimeout(() => {
          window.__RENDER_READY__ = true;
        }, 300);
      };
      if (images.length === 0) {
        settle();
      } else {
        let pending = images.length;
        const done = () => {
          pending -= 1;
          if (pending <= 0) settle();
        };
        images.forEach((img) => {
          if (img.complete) {
            done();
            return;
          }
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        });
      }
    </script>
  </body>
</html>`,
    rows: rows.length,
    sheetHeight,
    sheetWidth,
    thumbSize: averageThumbSize,
  };
};

const withVisionTimeout = ({
  imagePath,
  prompt,
  runtimeTraceDir,
  runtimeTraceLabel,
  signal,
}: {
  imagePath: string;
  prompt: string;
  runtimeTraceDir: string;
  runtimeTraceLabel: string;
  signal?: AbortSignal;
}) => {
  const controller = new AbortController();
  return new Promise<string>((resolve, reject) => {
    const relayAbort = () => controller.abort(signal?.reason ?? "aborted");
    const visionTextTimeoutMs = getVisionTextTimeoutMs();
    const timer = setTimeout(() => {
      controller.abort("module-semantic-vision-timeout");
      reject(
        new Error(
          `module semantic vision timed out after ${visionTextTimeoutMs}ms`,
        ),
      );
    }, visionTextTimeoutMs);
    signal?.addEventListener("abort", relayAbort, { once: true });
    if (signal?.aborted) relayAbort();
    runVisionLlm({
      imagePath,
      prompt,
      runtimeTraceDir,
      runtimeTraceLabel,
      signal: controller.signal,
    }).then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
        reject(error);
      },
    );
  });
};

const roundBox = (box: Box): Box => ({
  height: Number(box.height.toFixed(3)),
  width: Number(box.width.toFixed(3)),
  x: Number(box.x.toFixed(3)),
  y: Number(box.y.toFixed(3)),
});

const hasCompletedStages = (
  document: ModuleSemanticDocument,
  stages: string[],
) =>
  stages.every((stage) => document.runtime.completedStages.includes(stage));

const toElementClassification = (
  semantic: ModuleSemanticNodeSemantic,
): ElementClassification => {
  if (semantic.textHandling === "dom-text") return "plain-text";
  if (
    semantic.textHandling === "export-asset" &&
    semantic.containsReadableText === true
  ) {
    return "atomic-visual-text";
  }
  if (semantic.kind === "background") return "background";
  if (semantic.kind === "image") return "image";
  if (semantic.kind === "icon") return "icon";
  if (semantic.kind === "decoration") return "decoration";
  return semantic.exportDecision === "export" ? "decoration" : "skip";
};


const summarizeSemanticNodes = (
  document: ModuleSemanticDocument,
  nodes: ModuleSemanticNode[],
) => ({
  ...document.svgSummary,
  nodeCount: nodes.length,
  tagCounts: nodes.reduce<Record<string, number>>((accumulator, node) => {
    accumulator[node.tag] = (accumulator[node.tag] ?? 0) + 1;
    return accumulator;
  }, {}),
  textNodeCount: nodes.filter(
    (node) => typeof node.textContent === "string" && node.textContent.trim().length > 0,
  ).length,
  visibleNodeCount: nodes.filter((node) => node.visible).length,
});

const preserveExistingGeneratedAssets = (
  document: ModuleSemanticDocument,
) => (document.generatedAssets ?? []).slice();

const chooseProbePreviewBackground = (
  alphaStats: PngAlphaStats | null,
  node: SemanticProbeNode,
): ProbePreviewBackground => {
  const luminance =
    alphaStats?.averageLuminance ??
    readPaintLuminance(node.attrs.fill) ??
    readPaintLuminance(node.attrs.stroke);
  if (typeof luminance !== "number") return "light";
  return luminance >= 0.5 ? "dark" : "light";
};

const makeTransparentProbeSemantic = (): ModuleSemanticNodeSemantic => ({
  confidence: 1,
  containsReadableText: false,
  exportDecision: "skip",
  kind: "unknown",
  notes: "rendered semantic probe image is fully transparent; skipped before vision classification",
  textHandling: "ignore",
});

const createProbeImages = async ({
  moduleDir,
  probeDir,
  scale,
  visibleNodes,
}: {
  moduleDir: string;
  probeDir: string;
  scale: number;
  visibleNodes: SemanticProbeNode[];
}): Promise<ProbeImageResult> => {
  if (!visibleNodes.length) {
    return { artifacts: [], transparentNodeIds: [] };
  }
  const artifacts: ProbeArtifact[] = [];
  const transparentNodeIds: string[] = [];
  for (const node of visibleNodes) {
    const outputPath = path.join(probeDir, `${node.id}.png`);
    await exportSvgNodeAsset({
      allowText: true,
      assetRole: undefined,
      elementIndex: undefined,
      help: false,
      moduleDir,
      moduleSvg: "module.svg",
      nodeIds: [node.id],
      noRegisterSemantic: true,
      output: outputPath,
      padding: PROBE_PADDING,
      registerSemantic: false,
      scale: scale * SEMANTIC_PROBE_SCALE_MULTIPLIER,
      selector: undefined,
      textTreatment: undefined,
    }).catch((error) => {
      throw new Error(
        `failed to render semantic probe for ${node.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (!existsSync(outputPath)) {
      throw new Error(`semantic probe render completed without file: ${node.id}`);
    }
    const alphaStats = await readPngAlphaStats(outputPath);
    if (alphaStats?.hasAlpha === true && alphaStats.visiblePixelCount === 0) {
      transparentNodeIds.push(node.id);
      continue;
    }
    artifacts.push({
      node,
      outputPath,
      previewBackground: chooseProbePreviewBackground(alphaStats, node),
    });
  }
  return { artifacts, transparentNodeIds };
};

const renderAnalysisSheet = async ({
  outputPath,
  probes,
  sheetId,
  variant,
}: {
  outputPath: string;
  probes: ProbeArtifact[];
  sheetId: string;
  variant?: SheetRenderVariant;
}) => {
  const {
    cellPlacements,
    columns,
    html,
    rows,
    sheetHeight,
    sheetWidth,
    thumbSize,
  } = buildSheetHtml({ probes, variant });
  const wrapperPath = path.join(path.dirname(outputPath), `${sheetId}.html`);
  await writeFile(wrapperPath, html, "utf8");
  const browser = await launchEdge();
  try {
    await capturePage({
      deviceScaleFactor: getPngRasterScaleMultiplier(),
      outputPath,
      port: browser.port,
      transparentBackground: true,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: sheetHeight,
      viewportWidth: sheetWidth,
    });
  } finally {
    await browser.close();
    await rm(wrapperPath, { force: true });
  }
  return {
    cellPlacements,
    columns,
    rows,
    thumbSize,
  };
};

type RenderedAnalysisBatch = {
  batchSize: number;
  layout: Awaited<ReturnType<typeof renderAnalysisSheet>>;
  probes: ProbeArtifact[];
  sheetId: string;
  sheetPath: string;
};

const classifySheetWithVision = async ({
  cells,
  moduleDir,
  moduleId,
  moduleRegion,
  probes,
  signal,
  sessionId,
  sheetId,
  sheetPath,
}: {
  cells: SemanticProbeSheetCell[];
  moduleDir: string;
  moduleId: string;
  moduleRegion: SvgVerticalModule["region"];
  probes: ProbeArtifact[];
  signal?: AbortSignal;
  sessionId: string;
  sheetId: string;
  sheetPath: string;
}) => {
  const prompt = buildVisionPrompt({
    cells,
    moduleHeight: moduleRegion.height,
    moduleWidth: moduleRegion.width,
    nodes: probes.map((probe) => probe.node),
  });
  const traceDir = path.join(
    path.dirname(path.dirname(moduleDir)),
    "runtime-traces",
    path.basename(moduleDir),
    "module-semantic",
  );
  const raw = await withVisionTimeout({
    imagePath: sheetPath,
    prompt,
    runtimeTraceDir: traceDir,
    runtimeTraceLabel: `${moduleId}-${sheetId}`,
    signal,
  });
  const parsed = JSON.parse(stripJsonMarkdown(raw)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`semantic vision response for ${sheetId} is not a JSON array`);
  }

  const results = new Map<string, ModuleSemanticNodeSemantic>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const normalized = normalizeVisionNodeSemantic(item as VisionNodeSemantic);
    const id = readString((item as VisionNodeSemantic).id);
    if (!id) continue;
    results.set(id, normalized);
  }

  const missingIds = probes
    .map((probe) => probe.node.id)
    .filter((id) => !results.has(id));
  if (missingIds.length > 0) {
    throw new Error(
      `semantic vision response for ${sheetId} missed node(s): ${missingIds.join(", ")}`,
    );
  }
  sessionStore.addLog(
    sessionId,
    `[module-semantic] ${moduleId}: classified ${probes.length} node(s) from ${sheetId}`,
  );
  return results;
};

const hasMeaningfulPaint = (node: SemanticProbeNode) =>
  [node.attrs.fill, node.attrs.stroke].some((value) => {
    const token = value?.trim().toLowerCase();
    return Boolean(token && token !== "none" && token !== "transparent");
  });

const isLikelyTextRecheckCandidate = ({
  probe,
  semantic,
}: {
  probe: ProbeArtifact;
  semantic: ModuleSemanticNodeSemantic | undefined;
}) => {
  if (probe.node.tag !== "path" || !hasMeaningfulPaint(probe.node)) return false;
  if (semantic?.textHandling === "dom-text" && semantic.text) return false;
  if (semantic?.containsReadableText === true && semantic.text) return false;
  const { height, width } = probe.node.bbox;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide < 10 || shortSide > 42) return false;
  if (longSide < 24 || width * height < 280) return false;
  return longSide / Math.max(1, shortSide) >= 1.35;
};

const semanticReadabilityScore = (semantic: ModuleSemanticNodeSemantic | undefined) => {
  if (!semantic) return 0;
  if (semantic.textHandling === "dom-text" && semantic.text) return 4;
  if (semantic.textHandling === "export-asset" && semantic.text) return 3;
  if (semantic.containsReadableText === true && semantic.text) return 2;
  if (semantic.containsReadableText === true) return 1;
  return 0;
};

const shouldAdoptRecheckSemantic = ({
  current,
  next,
}: {
  current: ModuleSemanticNodeSemantic | undefined;
  next: ModuleSemanticNodeSemantic;
}) => {
  const currentScore = semanticReadabilityScore(current);
  const nextScore = semanticReadabilityScore(next);
  if (nextScore !== currentScore) return nextScore > currentScore;
  const currentTextLength = current?.text?.length ?? 0;
  const nextTextLength = next.text?.length ?? 0;
  return nextTextLength > currentTextLength;
};

const shouldClassifyProbeStandalone = (probe: ProbeArtifact) => {
  if (probe.node.tag !== "path") return false;
  const pathDataLength = Number(probe.node.attrs.pathDataLength ?? 0);
  return (
    Number.isFinite(pathDataLength) &&
    pathDataLength >= STANDALONE_PATH_DATA_LENGTH_MIN
  );
};

const runSuspiciousTextRecheck = async ({
  module,
  moduleDir,
  probeArtifacts,
  semanticsById,
  signal,
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  probeArtifacts: ProbeArtifact[];
  semanticsById: Map<string, ModuleSemanticNodeSemantic>;
  signal?: AbortSignal;
  sessionId: string;
  visionSemaphore: Semaphore;
}) => {
  const recheckCandidates = probeArtifacts
    .filter((probe) =>
      isLikelyTextRecheckCandidate({
        probe,
        semantic: semanticsById.get(probe.node.id),
      }),
    )
    .slice(0, MAX_TEXT_RECHECK_CANDIDATES);
  if (recheckCandidates.length === 0) return semanticsById;

  sessionStore.addLog(
    sessionId,
    `[module-semantic] ${module.id}: rechecking ${recheckCandidates.length} text-like node(s) with focused sheets`,
  );

  const nextSemantics = new Map(semanticsById);
  const analysisSheetsDir = path.join(moduleDir, "analysis-sheets");

  const recheckBatches: { probes: ProbeArtifact[]; sheetNumber: number }[] = [];
  for (
    let batchStart = 0;
    batchStart < recheckCandidates.length;
    batchStart += RECHECK_BATCH_SIZE
  ) {
    recheckBatches.push({
      probes: recheckCandidates.slice(batchStart, batchStart + RECHECK_BATCH_SIZE),
      sheetNumber: Math.floor(batchStart / RECHECK_BATCH_SIZE) + 1,
    });
  }

  const renderedRecheckBatches: RenderedAnalysisBatch[] = [];
  for (const { probes, sheetNumber } of recheckBatches) {
    const sheetId = `sheet-recheck-${String(sheetNumber).padStart(3, "0")}`;
    const sheetPath = path.join(analysisSheetsDir, `${sheetId}.png`);
    const layout = await renderAnalysisSheet({
      outputPath: sheetPath,
      probes,
      sheetId,
      variant: "recheck",
    });
    renderedRecheckBatches.push({
      batchSize: RECHECK_BATCH_SIZE,
      layout,
      probes,
      sheetId,
      sheetPath,
    });
  }

  await Promise.all(renderedRecheckBatches.map(async (renderedBatch) => {
    try {
      const recheckedSemantics = await visionSemaphore.run(() =>
        classifySheetWithVision({
          cells: renderedBatch.layout.cellPlacements,
          moduleDir,
          moduleId: module.id,
          moduleRegion: module.region,
          probes: renderedBatch.probes,
          signal,
          sessionId,
          sheetId: renderedBatch.sheetId,
          sheetPath: renderedBatch.sheetPath,
        }),
      );
      recheckedSemantics.forEach((semantic, id) => {
        if (
          shouldAdoptRecheckSemantic({
            current: nextSemantics.get(id),
            next: semantic,
          })
        ) {
          nextSemantics.set(id, semantic);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionStore.addLog(
        sessionId,
        `[module-semantic] ${module.id}: ${renderedBatch.sheetId} recheck failed: ${message}; keeping primary classifications`,
      );
    }
  }));

  return nextSemantics;
};

const runSemanticVisionPass = async ({
  module,
  moduleDir,
  probeArtifacts,
  signal,
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  probeArtifacts: ProbeArtifact[];
  signal?: AbortSignal;
  sessionId: string;
  visionSemaphore: Semaphore;
}) => {
  const analysisSheetsDir = path.join(moduleDir, "analysis-sheets");
  await rm(analysisSheetsDir, { force: true, recursive: true });
  await mkdir(analysisSheetsDir, { recursive: true });

  const sheets: ModuleSemanticAnalysisSheet[] = [];
  const sheetAssignments = new Map<
    string,
    { column: number; row: number; sheetId: string }
  >();
  const semanticsById = new Map<string, ModuleSemanticNodeSemantic>();
  let nextSheetNumber = 1;

  const makeFallbackSemantic = (
    error: Error,
  ): ModuleSemanticNodeSemantic => ({
    containsReadableText: false,
    contentType: "unknown",
    exportDecision: "export",
    kind: "unknown",
    notes: `Vision classification failed; treat as a non-text visual node for agent-driven export if needed: ${error.message}`,
    textHandling: "ignore",
  });

  let renderSheetChain = Promise.resolve();

  const renderBatchSheet = (
    probes: ProbeArtifact[],
    batchSizeIndex: number,
  ): Promise<RenderedAnalysisBatch | null> => {
    if (probes.length === 0) return Promise.resolve(null);
    const batchSize = ANALYSIS_BATCH_SIZES[batchSizeIndex];
    if (!batchSize) {
      throw new Error(
        `[module-semantic] ${module.id}: invalid analysis batch size index ${batchSizeIndex}`,
      );
    }

    const renderTask = renderSheetChain.then(async () => {
      const sheetNumber = nextSheetNumber;
      nextSheetNumber += 1;
      const sheetId = `sheet-${String(sheetNumber).padStart(3, "0")}`;
      const sheetPath = path.join(analysisSheetsDir, `${sheetId}.png`);
      const layout = await renderAnalysisSheet({
        outputPath: sheetPath,
        probes,
        sheetId,
      });
      return {
        batchSize,
        layout,
        probes,
        sheetId,
        sheetPath,
      };
    });

    renderSheetChain = renderTask.then(
      () => undefined,
      () => undefined,
    );
    return renderTask;
  };

  const recordSheet = ({
    renderedBatch,
    sheetSemantics,
  }: {
    renderedBatch: RenderedAnalysisBatch;
    sheetSemantics: Map<string, ModuleSemanticNodeSemantic>;
  }) => {
    sheets.push({
      batchSize: renderedBatch.batchSize,
      id: renderedBatch.sheetId,
      layout: {
        columns: renderedBatch.layout.columns,
        rows: renderedBatch.layout.rows,
        thumbSize: renderedBatch.layout.thumbSize,
      },
      nodeIds: renderedBatch.probes.map((probe) => probe.node.id),
      path: `analysis-sheets/${path.basename(renderedBatch.sheetPath)}`,
      readableByAgent: true,
    });
    renderedBatch.layout.cellPlacements.forEach((cell) => {
      sheetAssignments.set(cell.id, {
        column: cell.column,
        row: cell.row,
        sheetId: renderedBatch.sheetId,
      });
    });
    sheetSemantics.forEach((semantic, id) => {
      semanticsById.set(id, semantic);
    });
  };

  const recordFallbackSheet = ({
    error,
    renderedBatch,
  }: {
    error: Error;
    renderedBatch: RenderedAnalysisBatch;
  }) => {
    const fallbackSemantics = new Map<string, ModuleSemanticNodeSemantic>();
    renderedBatch.probes.forEach((probe) => {
      fallbackSemantics.set(probe.node.id, makeFallbackSemantic(error));
    });
    recordSheet({ renderedBatch, sheetSemantics: fallbackSemantics });
  };

  const classifyRenderedBatch = async (
    renderedBatch: RenderedAnalysisBatch,
    batchSizeIndex: number,
  ): Promise<void> => {
    try {
      const sheetSemantics = await visionSemaphore.run(() =>
        classifySheetWithVision({
          cells: renderedBatch.layout.cellPlacements,
          moduleDir,
          moduleId: module.id,
          moduleRegion: module.region,
          probes: renderedBatch.probes,
          signal,
          sessionId,
          sheetId: renderedBatch.sheetId,
          sheetPath: renderedBatch.sheetPath,
        }),
      );
      recordSheet({ renderedBatch, sheetSemantics });
    } catch (error) {
      const batchError =
        error instanceof Error ? error : new Error(String(error));
      const nextBatchSize = ANALYSIS_BATCH_SIZES[batchSizeIndex + 1];
      if (nextBatchSize) {
        sessionStore.addLog(
          sessionId,
          `[module-semantic] ${module.id}: ${renderedBatch.sheetId} batch size ${renderedBatch.batchSize} failed: ${batchError.message}; retrying ${renderedBatch.probes.length} node(s) with batch size ${nextBatchSize}`,
        );
        const retryBatches: ProbeArtifact[][] = [];
        for (
          let batchStart = 0;
          batchStart < renderedBatch.probes.length;
          batchStart += nextBatchSize
        ) {
          retryBatches.push(
            renderedBatch.probes.slice(batchStart, batchStart + nextBatchSize),
          );
        }
        const renderedRetryBatches: RenderedAnalysisBatch[] = [];
        for (const batch of retryBatches) {
          const retryBatch = await renderBatchSheet(batch, batchSizeIndex + 1);
          if (retryBatch) renderedRetryBatches.push(retryBatch);
        }
        await Promise.all(
          renderedRetryBatches.map((retryBatch) =>
            classifyRenderedBatch(retryBatch, batchSizeIndex + 1),
          ),
        );
        return;
      }
      sessionStore.addLog(
        sessionId,
        `[module-semantic] ${module.id}: ${renderedBatch.sheetId} batch size ${renderedBatch.batchSize} failed: ${batchError.message}; marking ${renderedBatch.probes.length} node(s) as visual export targets for agent-driven export`,
      );
      recordFallbackSheet({ error: batchError, renderedBatch });
    }
  };

  const initialBatchSize = ANALYSIS_BATCH_SIZES[0];
  const standaloneProbeArtifacts = probeArtifacts.filter(
    shouldClassifyProbeStandalone,
  );
  const batchedProbeArtifacts = probeArtifacts.filter(
    (probe) => !shouldClassifyProbeStandalone(probe),
  );

  if (standaloneProbeArtifacts.length > 0) {
    sessionStore.addLog(
      sessionId,
      `[module-semantic] ${module.id}: classifying ${standaloneProbeArtifacts.length} long path probe(s) as standalone sheets (pathDataLength>=${STANDALONE_PATH_DATA_LENGTH_MIN})`,
    );
  }

  const primaryBatches: ProbeArtifact[][] = [];
  for (
    let batchStart = 0;
    batchStart < batchedProbeArtifacts.length;
    batchStart += initialBatchSize
  ) {
    primaryBatches.push(
      batchedProbeArtifacts.slice(batchStart, batchStart + initialBatchSize),
    );
  }
  for (const probeArtifact of standaloneProbeArtifacts) {
    primaryBatches.push([probeArtifact]);
  }

  const renderedPrimaryBatches: RenderedAnalysisBatch[] = [];
  for (const batch of primaryBatches) {
    const renderedBatch = await renderBatchSheet(batch, 0);
    if (renderedBatch) renderedPrimaryBatches.push(renderedBatch);
  }
  await Promise.all(
    renderedPrimaryBatches.map((renderedBatch) =>
      classifyRenderedBatch(renderedBatch, 0),
    ),
  );

  const recheckedSemanticsById = await runSuspiciousTextRecheck({
    module,
    moduleDir,
    probeArtifacts,
    semanticsById,
    signal,
    sessionId,
    visionSemaphore,
  });
  return {
    semanticsById: recheckedSemanticsById,
    sheetAssignments,
    sheets: sheets.slice().sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const buildAnalysisResultFromDocument = (
  document: ModuleSemanticDocument,
): ModuleElementAnalysisResult => {
  const elements = document.nodes
    .filter((node): node is ModuleSemanticNode & { bbox: Box } => Boolean(node.bbox))
    .map((node) => {
      const classification = toElementClassification(node.semantic);
      return {
        bbox: toBboxArray(node.bbox),
        classification,
        containsText: node.semantic.containsReadableText,
        dLength: Number(node.attrs.pathDataLength ?? 0),
        exportDecision:
          node.semantic.exportDecision === "export" ? "export" : "skip",
        fill: node.attrs.fill ?? "",
        hasImage:
          node.tag === "image" ||
          Boolean(node.attrs.href) ||
          Boolean(node.attrs["xlink:href"]),
        index: node.inspectIndex,
        matchedTextBlockIds:
          node.semantic.containsReadableText && node.semantic.text
            ? [node.id]
            : undefined,
        matchedTextBlocks:
          node.semantic.containsReadableText && node.semantic.text
            ? [node.semantic.text]
            : undefined,
        nodeId: node.id,
        nodePath: node.nodePath,
        semanticText: node.semantic.text,
        sourceNodeSelector: node.selector,
        tag: node.tag,
        visionReason: node.semantic.notes,
      } satisfies AnalyzedElement;
    })
    .sort((left, right) => left.index - right.index);

  return {
    analysisVersion: MODULE_ELEMENT_ANALYSIS_VERSION,
    elements,
    skipIndices: elements
      .filter((element) => element.exportDecision === "skip")
      .map((element) => element.index),
  };
};

const analyzeModuleElements = async ({
  module,
  moduleDir,
  scale,
  signal,
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  scale: number;
  signal?: AbortSignal;
  sessionId: string;
  visionSemaphore: Semaphore;
}): Promise<ModuleElementAnalysisResult> => {
  const semantic = await readModuleSemanticDocument(moduleDir);
  if (!semantic) {
    throw new Error(`module-semantic.json not found for ${module.id}`);
  }

  if (
    hasCompletedStages(semantic, [
      "analysis-sheets",
      "semantic-pass",
    ])
  ) {
    return buildAnalysisResultFromDocument(semantic);
  }

  const deterministicById = new Map<string, ModuleSemanticNodeSemantic>();
  let deterministicTextCount = 0;
  let deterministicNonTextCount = 0;
  const allProbeCandidates = semantic.nodes.flatMap((node) => {
    const deterministic = buildDeterministicSemantic(node);
    if (deterministic) {
      deterministicById.set(node.id, deterministic);
      if (deterministic.textHandling === "dom-text") {
        deterministicTextCount += 1;
      } else {
        deterministicNonTextCount += 1;
      }
      return [];
    }
    const probeNode = toProbeNode(node);
    return probeNode ? [probeNode] : [];
  });

  // --- Text effect layer detection ---
  // Detect stacked text effect patterns (e.g. fill + outside-stroke layers
  // under the same parent <g>) and classify them deterministically. This
  // removes them from the vision candidate pool entirely.
  const textEffectGroups = detectTextEffectLayerGroups(semantic.nodes);
  const textEffectNodeIds = new Set<string>();
  if (textEffectGroups.length > 0) {
    const effectCount = applyTextEffectLayerSemantics(
      textEffectGroups,
      deterministicById,
      semantic.nodes,
    );
    for (const group of textEffectGroups) {
      textEffectNodeIds.add(group.parentId);
      textEffectNodeIds.add(group.fillNodeId);
      for (const eid of group.effectNodeIds) {
        textEffectNodeIds.add(eid);
      }
    }
    deterministicNonTextCount += effectCount;
    sessionStore.addLog(
      sessionId,
      `[module-semantic] ${module.id}: detected ${textEffectGroups.length} text effect group(s), removed ${textEffectNodeIds.size} node(s) from vision candidates`,
    );
  }

  // Filter out text effect layer nodes from probe candidates
  const filteredProbeCandidates = textEffectNodeIds.size > 0
    ? allProbeCandidates.filter((node) => !textEffectNodeIds.has(node.id))
    : allProbeCandidates;

  const {
    deduplicated: deduplicatedProbes,
    duplicateToRepresentative,
  } =
    deduplicateProbeNodes(filteredProbeCandidates);

  const probeNodes = deduplicatedProbes.filter((node) =>
    hasIntrinsicVisualPresence(node),
  );

  if (duplicateToRepresentative.size > 0) {
    sessionStore.addLog(
      sessionId,
      `[module-semantic] ${module.id}: deduplicated ${duplicateToRepresentative.size} visually identical probe(s), ${probeNodes.length} unique probes remain`,
    );
  }

  sessionStore.addLog(
    sessionId,
    `[module-semantic] ${module.id}: deterministic text=${deterministicTextCount}, deterministic non-text=${deterministicNonTextCount}, vision candidates=${probeNodes.length}`,
  );

  const nextNodes = semantic.nodes.map((node) => ({
    ...node,
    sheetCell: undefined,
    sheetId: undefined,
    semantic:
      deterministicById.get(node.id) ??
      ({
        containsReadableText: false,
        exportDecision: "pending",
        kind: "unknown",
        textHandling: "pending",
      } satisfies ModuleSemanticNodeSemantic),
  }));

  if (probeNodes.length === 0) {
    const nextDocument: ModuleSemanticDocument = {
      ...semantic,
      analysisSheets: [],
      generatedAssets: preserveExistingGeneratedAssets(semantic),
      nodes: nextNodes,
      runtime: {
        ...semantic.runtime,
        completedStages: [
          ...new Set([
            ...semantic.runtime.completedStages,
            "analysis-sheets",
            "semantic-pass",
          ]),
        ].sort((left, right) => left.localeCompare(right)),
      },
    };
    await writeModuleSemanticDocument({ document: nextDocument, moduleDir });
    return buildAnalysisResultFromDocument(nextDocument);
  }

  const probeDir = path.join(moduleDir, ".semantic-probes");
  await rm(probeDir, { force: true, recursive: true });
  await mkdir(probeDir, { recursive: true });

  const {
    artifacts: probeArtifacts,
    transparentNodeIds,
  } = await createProbeImages({
    moduleDir,
    probeDir,
    scale,
    visibleNodes: probeNodes,
  });

  if (transparentNodeIds.length > 0) {
    transparentNodeIds.forEach((id) => {
      deterministicById.set(id, makeTransparentProbeSemantic());
    });
    sessionStore.addLog(
      sessionId,
      `[module-semantic] ${module.id}: skipped ${transparentNodeIds.length} fully transparent rendered probe(s): ${transparentNodeIds.join(", ")}`,
    );
  }

  if (probeArtifacts.length === 0) {
    const completedNodes = nextNodes.map((node) => ({
      ...node,
      semantic: deterministicById.get(node.id) ?? node.semantic,
    }));
    const nextDocument: ModuleSemanticDocument = {
      ...semantic,
      analysisSheets: [],
      generatedAssets: preserveExistingGeneratedAssets(semantic),
      nodes: completedNodes,
      svgSummary: summarizeSemanticNodes(semantic, completedNodes),
      runtime: {
        ...semantic.runtime,
        completedStages: [
          ...new Set([
            ...semantic.runtime.completedStages,
            "analysis-sheets",
            "semantic-pass",
          ]),
        ].sort((left, right) => left.localeCompare(right)),
      },
    };
    await writeModuleSemanticDocument({ document: nextDocument, moduleDir });
    await rm(probeDir, { force: true, recursive: true });
    return buildAnalysisResultFromDocument(nextDocument);
  }

  const {
    deduplicatedArtifacts: pixelDeduplicatedProbeArtifacts,
    duplicateGroups: pixelDuplicateGroups,
    duplicateToRepresentative: pixelDuplicateToRepresentative,
  } = await deduplicateProbeArtifactsByPixels(probeArtifacts);

  if (pixelDuplicateToRepresentative.size > 0) {
    const groupSummary = pixelDuplicateGroups
      .slice(0, 5)
      .map(
        (group) =>
          `${group.representativeId}->${group.duplicateIds.join(",")}`,
      )
      .join("; ");
    sessionStore.addLog(
      sessionId,
      `[module-semantic] ${module.id}: pixel-deduplicated ${pixelDuplicateToRepresentative.size} rendered probe(s), ${pixelDeduplicatedProbeArtifacts.length} unique rendered probe(s) remain${groupSummary ? ` (${groupSummary})` : ""}`,
    );
  }

  const { semanticsById, sheetAssignments, sheets } = await runSemanticVisionPass({
    module,
    moduleDir,
    probeArtifacts: pixelDeduplicatedProbeArtifacts,
    signal,
    sessionId,
    visionSemaphore,
  });

  const allDuplicateToRepresentative = new Map([
    ...duplicateToRepresentative,
    ...pixelDuplicateToRepresentative,
  ]);

  // Backfill deduplicated probe nodes: copy the vision result from each
  // representative node to all its visual duplicates.
  for (const [duplicateId, representativeId] of allDuplicateToRepresentative) {
    const repSemantic = semanticsById.get(representativeId);
    if (repSemantic) {
      semanticsById.set(duplicateId, repSemantic);
    }
  }

  const finalizedNodes = nextNodes.map((node) => {
    const classified = semanticsById.get(node.id);
    const semanticValue = classified ?? deterministicById.get(node.id) ?? node.semantic;
    const assignment = sheetAssignments.get(node.id);
    return {
      ...node,
      semantic: semanticValue,
      ...(assignment
        ? {
            sheetCell: {
              column: assignment.column,
              row: assignment.row,
            },
            sheetId: assignment.sheetId,
          }
        : {}),
    };
  });

  // Build initial textBlocks from nodes classified as dom-text
  const textBlocks: ModuleSemanticTextBlock[] = finalizedNodes
    .filter(
      (node): node is typeof node & { bbox: Box; semantic: { text: string } } =>
        node.semantic.textHandling === "dom-text" &&
        Boolean(node.bbox) &&
        Boolean(node.semantic.text),
    )
    .map((node) => {
      const color = textColorFromNodePaint(node);
      return {
        ...(color ? { color } : {}),
        id: node.id,
        kind: node.semantic.textKind ?? node.semantic.kind,
        lineCount: node.semantic.lineCount,
        sourceNodeIds: [node.id],
        text: node.semantic.text,
        textRegion: roundBox(node.bbox),
      };
    });

  const nextDocument: ModuleSemanticDocument = {
    ...semantic,
    analysisSheets: sheets,
    generatedAssets: preserveExistingGeneratedAssets(semantic),
    nodes: finalizedNodes,
    svgSummary: summarizeSemanticNodes(semantic, finalizedNodes),
    textBlocks,
    runtime: {
      ...semantic.runtime,
      completedStages: [
        ...new Set([
          ...semantic.runtime.completedStages,
          "analysis-sheets",
          "semantic-pass",
        ]),
      ].sort((left, right) => left.localeCompare(right)),
    },
  };
  await writeModuleSemanticDocument({ document: nextDocument, moduleDir });
  await rm(probeDir, { force: true, recursive: true });
  return buildAnalysisResultFromDocument(nextDocument);
};

export {
  analyzeModuleElements,
};
