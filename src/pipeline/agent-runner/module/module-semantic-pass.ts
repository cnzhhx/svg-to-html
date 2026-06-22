import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  PNG_RASTER_SCALE_MULTIPLIER,
  VISION_TEXT_TIMEOUT_MS,
} from "../../../config/index.js";
import { capturePage, launchEdge } from "../../../core/cdp.js";
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
};

type ProbeArtifact = {
  node: SemanticProbeNode;
  outputPath: string;
};

const MODULE_ELEMENT_ANALYSIS_VERSION = 3;
const ANALYSIS_BATCH_SIZES = [9, 4, 1] as const;
const PROBE_PADDING = 0;
const SHEET_OUTER_PADDING = 16;
const SHEET_GAP = 12;
const CELL_INNER_PADDING = 8;
const SHEET_META_HEIGHT = 18;
const SHEET_META_GAP = 8;
const PREVIEW_PANEL_GAP = 6;
const PREVIEW_MIN_SHORT_SIDE = 48;
const PREVIEW_MAX_UPSCALE = 3;
const PREVIEW_MAX_LONG_SIDE = 240;
const RECHECK_BATCH_SIZE = 4;
const MAX_TEXT_RECHECK_CANDIDATES = 12;
const DUPLICATE_PARENT_EXPORT_NOTE =
  "Skip this node as an export target because this parent duplicates a single child with the same visual bounds.";
const PREFERRED_PARENT_BUNDLE_NOTE =
  "Skip this node as an export target because a compact parent visual bundle is a better grouped target than this child.";
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
  previewCount: number;
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

const hasDualPreviewNeed = (probe: ProbeArtifact, frameWidth: number, frameHeight: number) => {
  const shortSide = Math.min(frameWidth, frameHeight);
  if (shortSide <= 24) return true;
  const fillLuminance = readPaintLuminance(probe.node.attrs.fill);
  const strokeLuminance = readPaintLuminance(probe.node.attrs.stroke);
  return [fillLuminance, strokeLuminance].some(
    (luminance) => typeof luminance === "number" && luminance >= 0.72,
  );
};

const getPreviewScaleFactor = (frameWidth: number, frameHeight: number) => {
  const shortSide = Math.max(1, Math.min(frameWidth, frameHeight));
  const longSide = Math.max(frameWidth, frameHeight);
  const shortSideScale = PREVIEW_MIN_SHORT_SIDE / shortSide;
  const longSideScale = PREVIEW_MAX_LONG_SIDE / Math.max(1, longSide);
  if (shortSideScale <= 1) return 1;
  const cappedLongSideScale = longSideScale > 1 ? longSideScale : 1;
  return Math.max(
    1,
    Math.min(shortSideScale, PREVIEW_MAX_UPSCALE, cappedLongSideScale),
  );
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
    const previewScale = getPreviewScaleFactor(frameWidth, frameHeight);
    const previewWidth = Math.max(1, Math.round(frameWidth * previewScale));
    const previewHeight = Math.max(1, Math.round(frameHeight * previewScale));
    const previewCount = hasDualPreviewNeed(probe, frameWidth, frameHeight) ? 2 : 1;
    const displayFrameWidth =
      previewWidth * previewCount + PREVIEW_PANEL_GAP * Math.max(0, previewCount - 1);
    return {
      frameHeight,
      frameWidth,
      height:
        previewHeight +
        CELL_INNER_PADDING * 2 +
        SHEET_META_HEIGHT +
        SHEET_META_GAP,
      id: probe.node.id,
      previewCount,
      previewHeight,
      previewWidth,
      originalIndex,
      outputPath: probe.outputPath,
      width: displayFrameWidth + CELL_INNER_PADDING * 2,
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
        previewCount: cell.previewCount,
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
        gap: ${PREVIEW_PANEL_GAP}px;
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
          (cell) => `<section class="cell" style="left:${cell.x}px;top:${cell.y}px;width:${cell.width}px;height:${cell.height}px;--frame-width:${cell.previewWidth * cell.previewCount + PREVIEW_PANEL_GAP * Math.max(0, cell.previewCount - 1)}px;--frame-height:${cell.previewHeight}px;--preview-width:${cell.previewWidth}px;--preview-height:${cell.previewHeight}px;">
        <div class="meta"><span class="meta-index">#${cell.ordinal}</span><span class="meta-id">${cell.id}</span></div>
        <div class="frame">
          <div class="preview preview--light"><img src="${pathToFileURL(cell.outputPath).href}" alt="${cell.id}" /></div>
          ${
            cell.previewCount > 1
              ? `<div class="preview preview--dark"><img src="${pathToFileURL(cell.outputPath).href}" alt="${cell.id}" /></div>`
              : ""
          }
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
}: {
  imagePath: string;
  prompt: string;
  runtimeTraceDir: string;
  runtimeTraceLabel: string;
}) => {
  const controller = new AbortController();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort("module-semantic-vision-timeout");
      reject(
        new Error(
          `module semantic vision timed out after ${VISION_TEXT_TIMEOUT_MS}ms`,
        ),
      );
    }, VISION_TEXT_TIMEOUT_MS);
    runVisionLlm({
      imagePath,
      prompt,
      runtimeTraceDir,
      runtimeTraceLabel,
      signal: controller.signal,
    }).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
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

const normalizeVisionNodeSemantic = (
  input: VisionNodeSemantic,
): ModuleSemanticNodeSemantic => {
  const visionMarkedPureText = input.isPureText === true;
  const rawText = readString(input.text);
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
  // No children -> it's its own visual element.
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

const appendSemanticNote = (current: string | undefined, note: string) => {
  if (!current) return note;
  if (current.includes(note)) return current;
  return `${current}; ${note}`;
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
}) => {
  if (!visibleNodes.length) return [];
  const artifacts: ProbeArtifact[] = [];
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
        String(scale),
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
    artifacts.push({ node, outputPath });
  }
  return artifacts;
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
  sessionId,
  sheetId,
  sheetPath,
}: {
  cells: SemanticProbeSheetCell[];
  moduleDir: string;
  moduleId: string;
  moduleRegion: SvgVerticalModule["region"];
  probes: ProbeArtifact[];
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
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  probeArtifacts: ProbeArtifact[];
  semanticsById: Map<string, ModuleSemanticNodeSemantic>;
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
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  probeArtifacts: ProbeArtifact[];
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
  sessionId,
  visionSemaphore,
}: {
  module: SvgVerticalModule;
  moduleDir: string;
  scale: number;
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

  const deduplicateProbeNodes = (
    nodes: SemanticProbeNode[],
  ): {
    childToBundleParent: Map<string, string>;
    deduplicated: SemanticProbeNode[];
    parentToChild: Map<string, string>;
  } => ({
    childToBundleParent: new Map<string, string>(),
    deduplicated: nodes,
    parentToChild: new Map<string, string>(),
  });

  const {
    childToBundleParent,
    deduplicated: deduplicatedProbes,
    parentToChild: skippedParents,
  } =
    deduplicateProbeNodes(allProbeCandidates);

  const probeNodes = deduplicatedProbes.filter((node) =>
    hasIntrinsicVisualPresence(node),
  );

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

  const probeArtifacts = await createProbeImages({
    moduleDir,
    probeDir,
    scale,
    visibleNodes: probeNodes,
  });

  const { semanticsById, sheetAssignments, sheets } = await runSemanticVisionPass({
    module,
    moduleDir,
    probeArtifacts,
    sessionId,
    visionSemaphore,
  });

  // Backfill skipped parent nodes from their child semantic/sheet
  for (const [parentId, childId] of skippedParents) {
    const childSemantic = semanticsById.get(childId);
    if (childSemantic) {
      semanticsById.set(parentId, childSemantic);
    }
  }
  const skippedParentIds = new Set(skippedParents.keys());
  const bundledChildIds = new Set(childToBundleParent.keys());

  const finalizedNodes = nextNodes.map((node) => {
    const classified = semanticsById.get(node.id);
    const isDeduplicatedParent = skippedParentIds.has(node.id);
    const bundledParentId = childToBundleParent.get(node.id);
    const bundledParentSemantic = bundledParentId
      ? semanticsById.get(bundledParentId)
      : undefined;
    const semanticValue =
      isDeduplicatedParent && classified
        ? {
            ...classified,
            exportDecision: "skip" as const,
            notes: appendSemanticNote(
              classified.notes,
              DUPLICATE_PARENT_EXPORT_NOTE,
            ),
            textHandling:
              classified.textHandling === "export-asset"
                ? "ignore"
                : classified.textHandling,
          }
        : bundledParentSemantic && bundledChildIds.has(node.id)
          ? {
              ...bundledParentSemantic,
              exportDecision: "skip" as const,
              notes: appendSemanticNote(
                bundledParentSemantic.notes,
                PREFERRED_PARENT_BUNDLE_NOTE,
              ),
              textHandling:
                bundledParentSemantic.textHandling === "export-asset"
                  ? "ignore"
                  : bundledParentSemantic.textHandling,
            }
        : (classified ?? node.semantic);
    const assignment = isDeduplicatedParent
      ? undefined
      : sheetAssignments.get(node.id);
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
    .map((node) => ({
      id: node.id,
      kind: node.semantic.textKind ?? node.semantic.kind,
      lineCount: node.semantic.lineCount,
      sourceNodeIds: [node.id],
      text: node.semantic.text,
      textRegion: roundBox(node.bbox),
    }));

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
