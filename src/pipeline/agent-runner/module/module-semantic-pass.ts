import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import {
  PNG_RASTER_SCALE_MULTIPLIER,
  VISION_TEXT_TIMEOUT_MS,
} from "../../../config/index.js";
import { capturePage, launchEdge } from "../../../core/cdp.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import { type Box, intersectionArea, areaOf } from "../../../core/geometry.js";
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

const execFileAsync = promisify(execFile);

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

type SemanticProbeNode = ModuleSemanticNode & {
  bbox: Box;
  selector: string;
};

type VisionNodeSemantic = {
  isPureText?: boolean;
  id?: string;
  text?: string;
  lineCount?: number;
  contentType?: string;
  visualLines?: string[];
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

type PngAlphaStats = {
  averageLuminance?: number;
  hasAlpha: boolean;
  visiblePixelCount: number;
};

type ProbePreviewBackground = "dark" | "light";

const MODULE_ELEMENT_ANALYSIS_VERSION = 3;
const ANALYSIS_BATCH_SIZES = [6, 4, 2] as const;
const PROBE_PADDING = 0;
const PROBE_ALPHA_VISIBLE_THRESHOLD = 10;
const SHEET_OUTER_PADDING = 16;
const SHEET_GAP = 12;
const CELL_INNER_PADDING = 8;
const SHEET_META_HEIGHT = 18;
const SHEET_META_GAP = 8;
const PREVIEW_SCALE = 2;
const SEMANTIC_PROBE_SCALE_MULTIPLIER = 2;
const RECHECK_BATCH_SIZE = 4;
const MAX_TEXT_RECHECK_CANDIDATES = 12;

const MISSING_TEXT_RECHECK_NOTE =
  "Vision output looked text-like but omitted readable text; downgraded until recheck resolves it.";
const CONTAINER_VISUAL_TAGS = new Set(["a", "g", "svg", "switch", "symbol"]);

const IGNORED_TAGS = new Set([
  "clipPath",
  "defs",
  "desc",
  "filter",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "pattern",
  "radialGradient",
  "stop",
  "style",
  "symbol",
  "title",
].map((tag) => tag.toLowerCase()));

const JSON_MARKDOWN_RE = /^```(?:json)?\s*|\s*```$/gi;

const toBboxArray = (box: Box): [number, number, number, number] => [
  box.x,
  box.y,
  box.width,
  box.height,
];

const stripJsonMarkdown = (raw: string) => {
  let content = raw.trim();
  // Strip <think>...</think> tags (reasoning content from some models)
  content = content.replace(/<think>.*?<\/think>/gs, "");
  content = content.replace(/<think>/g, "");
  content = content.replace(/<\/think>/g, "");
  content = content.trim();
  content = content.replace(JSON_MARKDOWN_RE, "");
  const arrayStart = content.indexOf("[");
  const arrayEnd = content.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return content.slice(arrayStart, arrayEnd + 1);
  }
  return content;
};

const parseNumericAttr = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isExplicitPaint = (value: string | undefined) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== "none" &&
    normalized !== "transparent" &&
    !normalized.startsWith("url(")
  );
};

const formatAlpha = (value: number) =>
  Number(value.toFixed(3)).toString();

const applyPaintOpacity = (
  paint: string,
  opacity: number | undefined,
) => {
  if (opacity === undefined || opacity >= 0.999) return paint;
  if (opacity <= 0.001) return "rgba(0, 0, 0, 0)";
  const normalized = paint.trim();
  const alpha = formatAlpha(opacity);

  const hex = normalized.match(
    /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  );
  if (hex) {
    const raw = hex[1]!;
    const expand = (value: string) =>
      value.length === 1 ? `${value}${value}` : value;
    const r = Number.parseInt(
      raw.length <= 4 ? expand(raw[0]!) : raw.slice(0, 2),
      16,
    );
    const g = Number.parseInt(
      raw.length <= 4 ? expand(raw[1]!) : raw.slice(2, 4),
      16,
    );
    const b = Number.parseInt(
      raw.length <= 4 ? expand(raw[2]!) : raw.slice(4, 6),
      16,
    );
    const embeddedAlpha =
      raw.length === 4
        ? Number.parseInt(expand(raw[3]!), 16) / 255
        : raw.length === 8
          ? Number.parseInt(raw.slice(6, 8), 16) / 255
          : 1;
    return `rgba(${r}, ${g}, ${b}, ${formatAlpha(embeddedAlpha * opacity)})`;
  }

  const rgb = normalized.match(
    /^rgb\(\s*([^)]+)\s*\)$/i,
  );
  if (rgb) return `rgba(${rgb[1]}, ${alpha})`;

  return paint;
};

const textColorFromNodePaint = (node: ModuleSemanticNode) => {
  if (!isExplicitPaint(node.attrs.fill)) return undefined;
  const fillOpacity = parseNumericAttr(node.attrs["fill-opacity"]) ?? 1;
  const opacity = parseNumericAttr(node.attrs.opacity) ?? 1;
  return applyPaintOpacity(node.attrs.fill!.trim(), fillOpacity * opacity);
};

const isTransparentPaint = (value: string | undefined) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "transparent") {
    return true;
  }
  const rgba = normalized.match(
    /^rgba\(\s*[^,]+\s*,\s*[^,]+\s*,\s*[^,]+\s*,\s*([^)]+)\s*\)$/,
  );
  if (rgba) {
    const alpha = Number(rgba[1]);
    return Number.isFinite(alpha) && alpha <= 0.05;
  }
  const hexAlpha = normalized.match(/^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i);
  if (hexAlpha) {
    const alphaHex = normalized.length === 5 ? normalized.slice(4, 5).repeat(2) : normalized.slice(7, 9);
    const alpha = Number.parseInt(alphaHex, 16) / 255;
    return Number.isFinite(alpha) && alpha <= 0.05;
  }
  return false;
};

const isPureTransparentNode = (node: ModuleSemanticNode) => {
  const opacity = parseNumericAttr(node.attrs.opacity);
  if (opacity !== undefined && opacity <= 0.05) return true;
  if (node.attrs.display?.trim().toLowerCase() === "none") return true;
  if (node.attrs.visibility?.trim().toLowerCase() === "hidden") return true;
  if (node.tag === "text" || node.tag === "tspan" || node.tag === "image") {
    return false;
  }

  const fillTransparent =
    isTransparentPaint(node.attrs.fill) ||
    (parseNumericAttr(node.attrs["fill-opacity"]) ?? 1) <= 0.05;
  const strokeTransparent =
    isTransparentPaint(node.attrs.stroke) ||
    (parseNumericAttr(node.attrs["stroke-opacity"]) ?? 1) <= 0.05;

  return fillTransparent && strokeTransparent;
};

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

const parseHexPaintLuminance = (value: string) => {
  const normalized = value.trim().replace(/^#/, "");
  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized.length === 6
        ? normalized
        : "";
  if (!hex) return undefined;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  if (![red, green, blue].every(Number.isFinite)) return undefined;
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
};

const parseRgbPaintLuminance = (value: string) => {
  const match = value
    .trim()
    .match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+\s*)?\)$/i);
  if (!match) return undefined;
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if (![red, green, blue].every(Number.isFinite)) return undefined;
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
};

const readPaintLuminance = (value: string | undefined) => {
  const token = value?.trim().toLowerCase();
  if (!token || token === "none" || token === "transparent") return undefined;
  if (token === "white") return 1;
  if (token === "black") return 0;
  if (token.startsWith("#")) return parseHexPaintLuminance(token);
  if (token.startsWith("rgb")) return parseRgbPaintLuminance(token);
  return undefined;
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
      width: previewWidth + CELL_INNER_PADDING * 2,
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
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__RENDER_READY__ = true;
        }));
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
    const timer = setTimeout(() => {
      controller.abort("module-semantic-vision-timeout");
      reject(
        new Error(
          `module semantic vision timed out after ${VISION_TEXT_TIMEOUT_MS}ms`,
        ),
      );
    }, VISION_TEXT_TIMEOUT_MS);
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

const VALID_CONTENT_TYPES = new Set([
  "cover",
  "photo",
  "icon",
  "badge",
  "avatar",
  "background",
  "decoration",
  "unknown",
]);

const normalizeInlineText = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const normalizeDomText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => normalizeInlineText(line))
    .filter((line) => line.length > 0)
    .join("\n");

const normalizeVisualLineText = (value: unknown) =>
  typeof value === "string" ? normalizeInlineText(value) : undefined;

const readVisionVisualLines = (
  input: VisionNodeSemantic,
): string[] => {
  if (!Array.isArray(input.visualLines)) return [];
  return input.visualLines.flatMap((line) => {
    const text = normalizeVisualLineText(line);
    return text ? [text] : [];
  });
};

const mergeVisualLinesForDomText = ({
  fallbackText,
  visualLines,
}: {
  fallbackText: string;
  visualLines: string[];
}) => {
  const lines = visualLines
    .map((line) => normalizeInlineText(line))
    .filter((text) => text.length > 0);
  if (lines.length === 0) return normalizeDomText(fallbackText);
  return lines.join("\n");
};

const normalizeVisionNodeSemantic = (
  input: VisionNodeSemantic,
): ModuleSemanticNodeSemantic => {
  const visionMarkedPureText = input.isPureText === true;
  const visualLines = readVisionVisualLines(input);
  const rawText =
    mergeVisualLinesForDomText({
      fallbackText: readString(input.text) ?? "",
      visualLines,
    }) || readString(input.text);
  const rawContentType = readString(input.contentType);
  const contentType =
    rawContentType && VALID_CONTENT_TYPES.has(rawContentType)
      ? rawContentType
      : "unknown";

  if (visionMarkedPureText && !rawText) {
    return {
      containsReadableText: false,
      contentType,
      exportDecision: "export",
      kind: "unknown",
      notes: MISSING_TEXT_RECHECK_NOTE,
      textHandling: "ignore",
    };
  }
  const isPureText = visionMarkedPureText && Boolean(rawText);

  const lineCount =
    typeof input.lineCount === "number" && Number.isFinite(input.lineCount) && input.lineCount >= 1
      ? Math.round(input.lineCount)
      : visualLines.length > 0
        ? visualLines.length
      : undefined;

  return {
    containsReadableText: isPureText || Boolean(rawText),
    contentType,
    exportDecision: isPureText ? "skip" : "export",
    kind: isPureText ? "text" : rawText ? "visual-text" : "unknown",
    lineCount,
    text: rawText,
    textHandling: isPureText
      ? "dom-text"
      : rawText
        ? "export-asset"
        : "ignore",
    ...(visualLines.length > 0 ? { visualLines } : {}),
  };
};

/** Minimum dimension (px) below which a node is too small to carry readable text. */
const TINY_NODE_MIN_DIMENSION = 6;
/** Maximum area (px²) below which a node is too small to carry readable text. */
const TINY_NODE_MAX_AREA = 36;
/**
 * Maximum pathDataLength-to-perimeter ratio for a path to be considered a simple geometric
 * shape (not text). Text paths pack dense curve commands into their bounding box; simple
 * shapes (rounded rects, decorative outlines) have very few commands relative to perimeter.
 * Empirically: text paths >= 0.98, simple shapes <= 0.22. Threshold at 0.5 gives ~2x margin.
 */
const SIMPLE_SHAPE_PDL_PER_PERIMETER_MAX = 0.5;

const buildDeterministicSemantic = (
  node: ModuleSemanticNode,
): ModuleSemanticNodeSemantic | null => {
  const text = readString(node.textContent);
  if (node.depth === 0 || node.tag === "svg") {
    return {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "skip",
      kind: "container",
      notes: "module root",
      textHandling: "ignore",
    };
  }
  if (!node.visible || !node.bbox) {
    return {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "skip",
      kind: "unknown",
      notes: "non-visible or empty bounding box",
      textHandling: "ignore",
    };
  }
  if (IGNORED_TAGS.has(node.tag)) {
    return {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "skip",
      kind: "container",
      notes: "definition node",
      textHandling: "ignore",
    };
  }
  if (isPureTransparentNode(node)) {
    return {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "skip",
      kind: "unknown",
      notes: "pure transparent node",
      textHandling: "ignore",
    };
  }
  if (CONTAINER_VISUAL_TAGS.has(node.tag) && node.childIds.length > 0) {
    return {
      confidence: 1,
      containsReadableText: false,
      exportDecision: "skip",
      kind: "container",
      notes: "structural container analyzed via descendant single-node probes only",
      textHandling: "ignore",
    };
  }
  if ((node.tag === "text" || node.tag === "tspan") && text) {
    return {
      confidence: 1,
      containsReadableText: true,
      exportDecision: "skip",
      kind: "text",
      text,
      textHandling: "dom-text",
      textKind: "svg-text",
    };
  }
  if (DEFINITE_NON_TEXT_TAGS.has(node.tag)) {
    return {
      containsReadableText: false,
      exportDecision: "export",
      kind: node.tag === "image" ? "image" : "shape",
      notes:
        node.tag === "image"
          ? "bitmap/image node cannot be pure DOM text"
          : "simple geometric node cannot be pure DOM text",
      textHandling: "ignore",
    };
  }
  // --- Size-based deterministic rules (primarily reduces path candidates) ---
  const bbox = node.bbox;
  if (bbox) {
    const bboxWidth = bbox.width;
    const bboxHeight = bbox.height;
    const bboxArea = bboxWidth * bboxHeight;
    // Rule: extremely small nodes cannot carry readable text
    if (
      Math.min(bboxWidth, bboxHeight) < TINY_NODE_MIN_DIMENSION ||
      bboxArea < TINY_NODE_MAX_AREA
    ) {
      return {
        containsReadableText: false,
        exportDecision: "export",
        kind: "decoration",
        notes: `tiny node (${bboxWidth.toFixed(1)}×${bboxHeight.toFixed(1)}) cannot carry readable text`,
        textHandling: "ignore",
      };
    }
    // Rule: path with very low pathDataLength relative to perimeter is a simple geometric
    // shape (rounded rect, outline, separator) — not text.
    const pathDataLength = Number(node.attrs.pathDataLength ?? 0);
    if (node.tag === "path" && pathDataLength > 0) {
      const perimeter = 2 * (bboxWidth + bboxHeight);
      if (
        perimeter > 0 &&
        pathDataLength / perimeter < SIMPLE_SHAPE_PDL_PER_PERIMETER_MAX
      ) {
        return {
          containsReadableText: false,
          exportDecision: "export",
          kind: "shape",
          notes: `simple path shape (pdl/perimeter=${(pathDataLength / perimeter).toFixed(2)}, threshold=${SIMPLE_SHAPE_PDL_PER_PERIMETER_MAX})`,
          textHandling: "ignore",
        };
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Text effect layer detection
// ---------------------------------------------------------------------------
// Design tools (Figma, Sketch) often export text with visual effects (outside
// stroke, inner stroke, gradient overlay, etc.) as multiple stacked path nodes
// under a shared parent <g>. These effect layer paths share nearly identical
// bounding boxes with the text fill path but have significantly more complex
// path data (high pathDataLength) and typically carry a `mask` attribute.
//
// Detecting this pattern deterministically allows us to skip these nodes from
// the expensive vision classification pass and provide structured info to the
// module agent instead.
// ---------------------------------------------------------------------------

type TextEffectLayerGroup = {
  /** The parent <g> node containing the layers. */
  parentId: string;
  /** The primary fill layer node id (likely the actual text). */
  fillNodeId: string;
  /** The effect layer node id(s) (stroke/mask layers). */
  effectNodeIds: string[];
  /** Detected effect type description. */
  effectType: string;
};

/**
 * Detect text effect layer groups among the document nodes.
 *
 * Generic detection criteria (not dependent on specific URL naming):
 * 1. A parent <g> node (typically with a filter attribute for drop shadow).
 * 2. Contains 2+ leaf path children with no children of their own.
 * 3. At least one child path has a `mask` attribute (the effect layer).
 * 4. The masked path's bbox overlaps significantly with a sibling's bbox
 *    (overlap ratio > 0.6 based on smaller area).
 * 5. The masked path has substantially higher pathDataLength than the fill
 *    sibling (ratio >= 3x), indicating it carries outline/stroke geometry.
 */
const detectTextEffectLayerGroups = (
  nodes: ModuleSemanticNode[],
): TextEffectLayerGroup[] => {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const groups: TextEffectLayerGroup[] = [];
  const processedIds = new Set<string>();

  for (const node of nodes) {
    // Only inspect <g> nodes that are containers
    if (node.tag !== "g") continue;
    if (!node.childIds || node.childIds.length < 2) continue;

    // Gather leaf path children
    const pathChildren: ModuleSemanticNode[] = [];
    for (const childId of node.childIds) {
      const child = nodesById.get(childId);
      if (
        child &&
        child.tag === "path" &&
        child.childIds.length === 0 &&
        child.bbox
      ) {
        pathChildren.push(child);
      }
    }
    if (pathChildren.length < 2) continue;

    // Identify effect layers: paths with a mask attribute
    const effectCandidates = pathChildren.filter((c) => Boolean(c.attrs.mask));
    if (effectCandidates.length === 0) continue;

    // Identify fill candidates: paths WITHOUT a mask
    const fillCandidates = pathChildren.filter((c) => !c.attrs.mask);
    if (fillCandidates.length === 0) continue;

    // For each effect candidate, find a matching fill sibling
    const effectNodeIds: string[] = [];
    let fillNodeId: string | undefined;
    let effectType = "masked-layer";

    for (const effect of effectCandidates) {
      if (!effect.bbox) continue;
      const effectPdl = Number(effect.attrs.pathDataLength ?? 0);

      // Find a fill sibling with high bbox overlap
      const matchingFill = fillCandidates.find((fill) => {
        if (!fill.bbox) return false;
        const smaller = Math.min(areaOf(fill.bbox), areaOf(effect.bbox!));
        if (smaller <= 0) return false;
        const overlap = intersectionArea(fill.bbox, effect.bbox!) / smaller;
        if (overlap < 0.6) return false;

        // Verify pdl ratio: effect layer should have significantly more path data
        const fillPdl = Number(fill.attrs.pathDataLength ?? 0);
        if (fillPdl <= 0 || effectPdl <= 0) return false;
        const pdlRatio = effectPdl / fillPdl;
        return pdlRatio >= 3;
      });

      if (matchingFill) {
        effectNodeIds.push(effect.id);
        fillNodeId = matchingFill.id;

        // Infer effect type from mask URL or attributes
        const mask = effect.attrs.mask ?? "";
        if (mask.includes("outside")) {
          effectType = "outside-stroke";
        } else if (mask.includes("inside")) {
          effectType = "inside-stroke";
        }
      }
    }

    if (fillNodeId && effectNodeIds.length > 0 && !processedIds.has(fillNodeId)) {
      groups.push({
        parentId: node.id,
        fillNodeId,
        effectNodeIds,
        effectType,
      });
      processedIds.add(fillNodeId);
      effectNodeIds.forEach((id) => processedIds.add(id));
    }
  }

  return groups;
};

/**
 * Apply deterministic semantics for detected text effect layer groups.
 * The parent group is the export target so the fill and effect layers stay
 * merged as one visual asset. Child layers are skipped to prevent agents from
 * exporting only the fill path and dropping masks/strokes.
 */
const applyTextEffectLayerSemantics = (
  groups: TextEffectLayerGroup[],
  deterministicById: Map<string, ModuleSemanticNodeSemantic>,
  nodes: ModuleSemanticNode[],
) => {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  let count = 0;

  for (const group of groups) {
    const parentNode = nodesById.get(group.parentId);

    // Mark parent <g>: export the complete text effect bundle.
    if (parentNode) {
      deterministicById.set(group.parentId, {
        containsReadableText: true,
        exportDecision: "export",
        kind: "text-effect-group",
        notes: `text effect group (${group.effectType}); fill: ${group.fillNodeId}; effects: [${group.effectNodeIds.join(", ")}]`,
        textHandling: "export-asset",
      });
      count += 1;
    }

    // Mark fill layer as skipped because the parent group is the export target.
    deterministicById.set(group.fillNodeId, {
      containsReadableText: true,
      exportDecision: "skip",
      kind: "visual-text",
      notes: `text fill layer of ${group.parentId}; export parent text effect group to preserve ${group.effectType}`,
      textHandling: "ignore",
    });
    count += 1;

    // Mark effect layer(s): skip entirely, they are decorative companions
    for (const effectId of group.effectNodeIds) {
      deterministicById.set(effectId, {
        containsReadableText: false,
        exportDecision: "skip",
        kind: "text-effect-layer",
        notes: `${group.effectType} effect layer of ${group.fillNodeId}; parent: ${group.parentId}`,
        textHandling: "ignore",
      });
      count += 1;
    }
  }

  return count;
};

const toProbeNode = (node: ModuleSemanticNode): SemanticProbeNode | null =>
  node.bbox && node.selector && node.childIds.length === 0
    ? {
        ...node,
        bbox: node.bbox,
        selector: node.selector,
      }
    : null;

const SHAPE_TAGS = new Set([
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
]);

const DEFINITE_NON_TEXT_TAGS = new Set([
  "circle",
  "ellipse",
  "image",
  "line",
  "rect",
]);

const hasIntrinsicVisualPresence = (node: SemanticProbeNode): boolean => {
  // Leaf nodes may render themselves. Fully transparent leaf output is pruned
  // after probe rasterization, which catches empty foreignObject/backdrop-filter
  // scaffolding without dropping legitimate <use> or custom SVG elements.
  if (node.childIds.length === 0) return true;
  // Text and image nodes always carry their own content.
  if (
    node.tag === "text" ||
    node.tag === "tspan" ||
    node.tag === "image"
  ) {
    return true;
  }
  // Native shape tags always render something (they have geometry).
  if (SHAPE_TAGS.has(node.tag)) return true;
  // Everything else is a structural container whose visual output comes
  // entirely from descendants. Skip from vision analysis.
  return false;
};

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

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const getPngChannelCount = (colorType: number) => {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      return undefined;
  }
};

const paethPredictor = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
};

const readPngAlphaStats = async (
  filePath: string,
): Promise<PngAlphaStats | null> => {
  const buffer = await readFile(filePath);
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return null;
  }

  let bitDepth = 0;
  let colorType = -1;
  let height = 0;
  let interlace = 0;
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd + 4 > buffer.length) return null;

    if (chunkType === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8] ?? 0;
      colorType = buffer[dataStart + 9] ?? -1;
      interlace = buffer[dataStart + 12] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (chunkType === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  const channelCount = getPngChannelCount(colorType);
  if (
    !channelCount ||
    bitDepth !== 8 ||
    height <= 0 ||
    idatChunks.length === 0 ||
    interlace !== 0 ||
    width <= 0
  ) {
    return null;
  }

  const hasAlpha = colorType === 4 || colorType === 6;
  if (!hasAlpha) {
    return { hasAlpha: false, visiblePixelCount: width * height };
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rowLength = width * channelCount;
  const previous = new Uint8Array(rowLength);
  const current = new Uint8Array(rowLength);
  let sourceOffset = 0;
  let luminanceSum = 0;
  let visiblePixelCount = 0;
  const alphaChannelOffset = colorType === 6 ? 3 : 1;

  for (let y = 0; y < height; y += 1) {
    if (sourceOffset >= inflated.length) return null;
    const filterType = inflated[sourceOffset] ?? -1;
    sourceOffset += 1;
    if (sourceOffset + rowLength > inflated.length) return null;

    for (let x = 0; x < rowLength; x += 1) {
      const raw = inflated[sourceOffset + x] ?? 0;
      const left = x >= channelCount ? (current[x - channelCount] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft =
        x >= channelCount ? (previous[x - channelCount] ?? 0) : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, up, upLeft);
          break;
        default:
          return null;
      }
      current[x] = value & 0xff;
    }

    sourceOffset += rowLength;

    for (let pixelOffset = 0; pixelOffset < rowLength; pixelOffset += channelCount) {
      const alpha = current[pixelOffset + alphaChannelOffset] ?? 0;
      if (alpha > PROBE_ALPHA_VISIBLE_THRESHOLD) {
        const red = current[pixelOffset] ?? 0;
        const green =
          colorType === 6
            ? current[pixelOffset + 1] ?? red
            : red;
        const blue =
          colorType === 6
            ? current[pixelOffset + 2] ?? red
            : red;
        luminanceSum += (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
        visiblePixelCount += 1;
      }
    }

    previous.set(current);
    current.fill(0);
  }

  return {
    averageLuminance:
      visiblePixelCount > 0 ? luminanceSum / visiblePixelCount : undefined,
    hasAlpha,
    visiblePixelCount,
  };
};

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
    await execFileAsync(
      "pnpm",
      [
        "--dir",
        process.cwd(),
        "exec",
        "tsx",
        path.join(process.cwd(), "src/cli/export-svg-node-asset.ts"),
        "--module-dir",
        moduleDir,
        "--index",
        String(node.inspectIndex),
        "--allow-text",
        "--output",
        outputPath,
        "--padding",
        String(PROBE_PADDING),
        "--scale",
        String(scale * SEMANTIC_PROBE_SCALE_MULTIPLIER),
      ],
      { timeout: 60_000 },
    ).catch((error) => {
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
      deviceScaleFactor: PNG_RASTER_SCALE_MULTIPLIER,
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

  await Promise.all(
    recheckBatches.map(async ({ probes, sheetNumber }) => {
      const sheetId = `sheet-recheck-${String(sheetNumber).padStart(3, "0")}`;
      const sheetPath = path.join(analysisSheetsDir, `${sheetId}.png`);
      const layout = await renderAnalysisSheet({
        outputPath: sheetPath,
        probes,
        sheetId,
        variant: "recheck",
      });
      try {
        const recheckedSemantics = await visionSemaphore.run(() =>
          classifySheetWithVision({
            cells: layout.cellPlacements,
            moduleDir,
            moduleId: module.id,
            moduleRegion: module.region,
            probes,
            signal,
            sessionId,
            sheetId,
            sheetPath,
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
          `[module-semantic] ${module.id}: ${sheetId} recheck failed: ${message}; keeping primary classifications`,
        );
      }
    }),
  );

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

  const classifyBatch = async (
    probes: ProbeArtifact[],
    batchSizeIndex: number,
  ): Promise<void> => {
    if (probes.length === 0) return;
    const batchSize = ANALYSIS_BATCH_SIZES[batchSizeIndex];
    if (!batchSize) {
      throw new Error(
        `[module-semantic] ${module.id}: invalid analysis batch size index ${batchSizeIndex}`,
      );
    }
    const sheetNumber = nextSheetNumber;
    nextSheetNumber += 1;
    const sheetId = `sheet-${String(sheetNumber).padStart(3, "0")}`;
    const sheetPath = path.join(analysisSheetsDir, `${sheetId}.png`);
    const layout = await renderAnalysisSheet({
      outputPath: sheetPath,
      probes,
      sheetId,
    });
    try {
      const sheetSemantics = await visionSemaphore.run(() =>
        classifySheetWithVision({
          cells: layout.cellPlacements,
          moduleDir,
          moduleId: module.id,
          moduleRegion: module.region,
          probes,
          signal,
          sessionId,
          sheetId,
          sheetPath,
        }),
      );
      sheets.push({
        batchSize,
        id: sheetId,
        layout: {
          columns: layout.columns,
          rows: layout.rows,
          thumbSize: layout.thumbSize,
        },
        nodeIds: probes.map((probe) => probe.node.id),
        path: `analysis-sheets/${path.basename(sheetPath)}`,
        readableByAgent: true,
      });
      layout.cellPlacements.forEach((cell) => {
        sheetAssignments.set(cell.id, {
          column: cell.column,
          row: cell.row,
          sheetId,
        });
      });
      sheetSemantics.forEach((semantic, id) => {
        semanticsById.set(id, semantic);
      });
    } catch (error) {
      const batchError =
        error instanceof Error ? error : new Error(String(error));
      const nextBatchSize = ANALYSIS_BATCH_SIZES[batchSizeIndex + 1];
      if (nextBatchSize) {
        sessionStore.addLog(
          sessionId,
          `[module-semantic] ${module.id}: ${sheetId} batch size ${batchSize} failed: ${batchError.message}; retrying ${probes.length} node(s) with batch size ${nextBatchSize}`,
        );
        const retryBatches: ProbeArtifact[][] = [];
        for (
          let batchStart = 0;
          batchStart < probes.length;
          batchStart += nextBatchSize
        ) {
          retryBatches.push(probes.slice(batchStart, batchStart + nextBatchSize));
        }
        await Promise.all(
          retryBatches.map((batch) => classifyBatch(batch, batchSizeIndex + 1)),
        );
        return;
      }
      sessionStore.addLog(
        sessionId,
        `[module-semantic] ${module.id}: ${sheetId} batch size ${batchSize} failed: ${batchError.message}; marking ${probes.length} node(s) as visual export targets for agent-driven export`,
      );
      sheets.push({
        batchSize,
        id: sheetId,
        layout: {
          columns: layout.columns,
          rows: layout.rows,
          thumbSize: layout.thumbSize,
        },
        nodeIds: probes.map((probe) => probe.node.id),
        path: `analysis-sheets/${path.basename(sheetPath)}`,
        readableByAgent: true,
      });
      layout.cellPlacements.forEach((cell) => {
        sheetAssignments.set(cell.id, {
          column: cell.column,
          row: cell.row,
          sheetId,
        });
      });
      probes.forEach((probe) => {
        semanticsById.set(probe.node.id, makeFallbackSemantic(batchError));
      });
    }
  };

  const initialBatchSize = ANALYSIS_BATCH_SIZES[0];
  const primaryBatches: ProbeArtifact[][] = [];
  for (
    let batchStart = 0;
    batchStart < probeArtifacts.length;
    batchStart += initialBatchSize
  ) {
    primaryBatches.push(
      probeArtifacts.slice(batchStart, batchStart + initialBatchSize),
    );
  }
  await Promise.all(primaryBatches.map((batch) => classifyBatch(batch, 0)));

  const recheckedSemanticsById = await runSuspiciousTextRecheck({
    module,
    moduleDir,
    probeArtifacts,
    semanticsById,
    signal,
    sessionId,
    visionSemaphore,
  });
  return { semanticsById: recheckedSemanticsById, sheetAssignments, sheets };
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

  // --- Probe node deduplication ---
  // Nodes with identical visual fingerprints (same tag, same bbox dimensions,
  // same visual attributes) will produce identical probe images. We only need
  // to send one representative to the vision model and copy the result to all
  // duplicates. This significantly reduces vision calls for designs with
  // repeated visual elements (e.g. same icon/text in a card grid).
  const deduplicateProbeNodes = (
    nodes: SemanticProbeNode[],
  ): {
    deduplicated: SemanticProbeNode[];
    duplicateToRepresentative: Map<string, string>;
  } => {
    if (nodes.length <= 1) {
      return { deduplicated: nodes, duplicateToRepresentative: new Map() };
    }

    // Compute a visual fingerprint for each node based on properties that
    // determine its rendered appearance (independent of position).
    const computeFingerprint = (node: SemanticProbeNode): string => {
      if (node.tag === "image") return `${node.tag}|${node.id}`;
      const attrs = node.attrs;
      const parts = [
        node.tag,
        // bbox dimensions (rounded to avoid floating point noise)
        Math.round(node.bbox.width * 1000).toString(),
        Math.round(node.bbox.height * 1000).toString(),
        // visual attributes that affect rendering
        attrs.pathDataLength ?? "",
        attrs.fill ?? "",
        attrs.stroke ?? "",
        attrs.opacity ?? "",
        attrs.mask ?? "",
        attrs["clip-path"] ?? "",
        attrs["fill-opacity"] ?? "",
        attrs["stroke-width"] ?? "",
      ];
      return parts.join("|");
    };

    const fingerprintGroups = new Map<string, SemanticProbeNode[]>();
    for (const node of nodes) {
      const fp = computeFingerprint(node);
      const group = fingerprintGroups.get(fp);
      if (group) {
        group.push(node);
      } else {
        fingerprintGroups.set(fp, [node]);
      }
    }

    const deduplicated: SemanticProbeNode[] = [];
    const duplicateToRepresentative = new Map<string, string>();

    for (const [, group] of fingerprintGroups) {
      if (group.length === 0) continue;
      // First node in the group is the representative
      const representative = group[0]!;
      deduplicated.push(representative);

      // Map all other nodes in the group to the representative
      for (let i = 1; i < group.length; i++) {
        duplicateToRepresentative.set(group[i]!.id, representative.id);
      }
    }

    return { deduplicated, duplicateToRepresentative };
  };

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

  const { semanticsById, sheetAssignments, sheets } = await runSemanticVisionPass({
    module,
    moduleDir,
    probeArtifacts,
    signal,
    sessionId,
    visionSemaphore,
  });

  // Backfill deduplicated probe nodes: copy the vision result from each
  // representative node to all its visual duplicates.
  for (const [duplicateId, representativeId] of duplicateToRepresentative) {
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
