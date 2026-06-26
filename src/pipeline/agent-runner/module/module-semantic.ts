import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PNG_RASTER_SCALE_MULTIPLIER } from "../../../config/index.js";
import { capturePage, launchEdge } from "../../../core/cdp.js";
import type { Box } from "../../../core/geometry.js";
import { isRecord } from "../../../core/type-guards.js";
import { parseSvgSize } from "../../../core/svg-parse.js";
import { writeJsonFile, writeTextFile } from "../../../core/file-io.js";
import { readSvgLayout } from "../../../core/svg-layout.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { ModuleOutputAllowedAsset } from "../../module-output-policy.js";

const MODULE_REFERENCE_RENDER_VERSION = 3;

type ModuleSemanticNodeAttrs = Record<string, string>;

type ModuleSemanticNodeSemantic = {
  containsReadableText?: boolean;
  confidence?: number;
  contentType?: string;
  exportDecision: "export" | "pending" | "skip";
  kind: string;
  lineCount?: number;
  notes?: string;
  text?: string;
  textHandling: "dom-text" | "export-asset" | "ignore" | "pending";
  textKind?: string;
  visualLines?: string[];
};

type ModuleSemanticVisualEffect = {
  candidateTargetNodeIds?: string[];
  color?: string;
  cssHint?: string;
  dx?: number;
  dy?: number;
  edge?: "bottom" | "left" | "right" | "top";
  edges?: Array<"bottom" | "left" | "right" | "top">;
  opacity?: number;
  source: "svg-filter";
  sourceContainerNodeId?: string;
  sourceFilterId: string;
  type: "inner-shadow";
};

type ModuleSemanticNode = {
  attrs: ModuleSemanticNodeAttrs;
  bbox?: Box;
  childIds: string[];
  depth: number;
  id: string;
  inspectIndex: number;
  nodePath: string;
  parentId: null | string;
  semantic: ModuleSemanticNodeSemantic;
  selector?: string;
  siblingIndex: number;
  sheetCell?: {
    column: number;
    row: number;
  };
  sheetId?: string;
  tag: string;
  textContent?: string;
  viewBoxBox?: Box;
  visible: boolean;
  /** Actual visible bounding box after clip-path/mask cropping (intersection of bbox and clip/mask region). */
  visibleBox?: Box;
  visualEffects?: ModuleSemanticVisualEffect[];
};

type ModuleSemanticTextBlockStyleInference = {
  "font-family"?: string;
  "font-size"?: string;
  "font-weight"?: string;
  "letter-spacing"?: string;
  "line-height"?: string;
  "white-space"?: string;
};

type ModuleSemanticTextBlock = {
  color?: string;
  id: string;
  kind?: string;
  lineRegions?: Box[];
  lines?: Array<{ region?: Box; text?: string }>;
  [key: string]: unknown;
  region?: Box;
  renderedTextRegion?: Box;
  sourceNodeIds: string[];
  styleInference?: ModuleSemanticTextBlockStyleInference;
  text: string;
  textRegion: Box;
};

type ModuleSemanticGeneratedAsset = {
  assetRole: string;
  box?: Box;
  contentType?: string;
  htmlRef?: string;
  id: string;
  path: string;
  [key: string]: unknown;
  readableByAgent: boolean;
  relativePath?: string;
  source?: string;
  sourceNodeIds: string[];
  sourceNodePaths?: string[];
  textTreatment: string;
};

type ModuleSemanticAnalysisSheet = {
  batchSize: number;
  id: string;
  layout?: {
    columns: number;
    rows: number;
    thumbSize: number;
  };
  nodeIds: string[];
  path: string;
  readableByAgent: boolean;
};

type ModuleSemanticDocument = {
  analysisSheets: ModuleSemanticAnalysisSheet[];
  generatedAssets: ModuleSemanticGeneratedAsset[];
  module: {
    id: string;
    kind: string;
    region: SvgVerticalModule["region"];
    scale: number;
  };
  nodes: ModuleSemanticNode[];
  runtime: {
    completedStages: string[];
    nodeFactVersion: number;
    referenceRenderVersion?: number;
    schemaVersion: number;
    semanticPassVersion: number;
    textStylePassVersion: number;
  };
  sourceImage: {
    height: number;
    id: string;
    path: string;
    readableByAgent: boolean;
    width: number;
  };
  svgSummary: {
    nodeCount: number;
    rootAttrs: ModuleSemanticNodeAttrs;
    tagCounts: Record<string, number>;
    textNodeCount: number;
    visibleNodeCount: number;
  };
  summaryStats?: Record<string, unknown>;
  textBlocks: ModuleSemanticTextBlock[];
};

type CreateModuleSemanticDraftInput = {
  module: SvgVerticalModule;
  moduleDir: string;
  moduleSvgPath: string;
  scale: number;
};

type CreateModuleSemanticDraftResult = {
  document: ModuleSemanticDocument;
  jsonPath: string;
  sourceImagePath: string;
};

const MODULE_SEMANTIC_SCHEMA_VERSION = 2;
const MODULE_SEMANTIC_NODE_FACT_VERSION = 4;
const MODULE_SEMANTIC_SEMANTIC_PASS_VERSION = 5;
const MODULE_SEMANTIC_TEXT_STYLE_PASS_VERSION = 6;

const IMPORTANT_ATTRS = new Set([
  "class",
  "clip-path",
  "computed-font-family",
  "computed-font-size",
  "computed-font-weight",
  "computed-letter-spacing",
  "cx",
  "cy",
  "display",
  "dominant-baseline",
  "fill",
  "fillOpaque",
  "fill-opacity",
  "fill-rule",
  "filter",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "href",
  "id",
  "letter-spacing",
  "mask",
  "opacity",
  "pathDataHash",
  "pathDataLength",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "visibility",
  "viewBox",
  "width",
  "x",
  "xlink:href",
  "y",
]);

const toRelativeModulePath = (moduleDir: string, filePath: string) =>
  path.relative(moduleDir, filePath).replaceAll(path.sep, "/") || path.basename(filePath);

const readString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const readExplicitPaint = (value: unknown) => {
  const paint = readString(value)?.trim();
  if (!paint) return undefined;
  const normalized = paint.toLowerCase();
  if (
    normalized === "none" ||
    normalized === "transparent" ||
    normalized.startsWith("url(")
  ) {
    return undefined;
  }
  return paint;
};

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pickImportantAttrs = (attrs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(attrs).filter(([name]) => IMPORTANT_ATTRS.has(name)),
  );

export const nodePathToSelector = (nodePath: string | undefined) => {
  if (!nodePath) return undefined;
  const trimmed = nodePath.trim();
  if (!trimmed || trimmed === "svg:nth-of-type(1)") return undefined;
  return trimmed.replace(/^svg:nth-of-type\(1\)\s*>\s*/, "");
};

const hasMeaningfulBox = (box: Box | null | undefined): box is Box => {
  if (!box) return false;
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
};

const BOX_EPSILON = 0.01;

const boxesMatch = (left: Box | undefined, right: Box | undefined) => {
  if (!left || !right) return false;
  return (
    Math.abs(left.x - right.x) <= BOX_EPSILON &&
    Math.abs(left.y - right.y) <= BOX_EPSILON &&
    Math.abs(left.width - right.width) <= BOX_EPSILON &&
    Math.abs(left.height - right.height) <= BOX_EPSILON
  );
};

const readNumericAttr = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readOpacityProduct = (node: ModuleSemanticNode) => {
  const opacity = readNumericAttr(node.attrs.opacity) ?? 1;
  const fillOpacity = readNumericAttr(node.attrs["fill-opacity"]) ?? 1;
  const strokeOpacity = readNumericAttr(node.attrs["stroke-opacity"]) ?? 1;
  return {
    fill: opacity * fillOpacity,
    opacity,
    stroke: opacity * strokeOpacity,
  };
};

const hasLayerSideEffects = (node: ModuleSemanticNode) =>
  Boolean(
    node.attrs.filter ||
      node.attrs.mask ||
      node.attrs["clip-path"] ||
      node.attrs.transform,
  );

const isOpaqueFillToken = (fillPaint: string) => {
  if (fillPaint === "none" || fillPaint === "transparent") return false;
  return !fillPaint.startsWith("url(");
};

const hasOpaqueFillPaint = (node: ModuleSemanticNode) => {
  const { fill } = readOpacityProduct(node);
  const fillPaint = node.attrs.fill?.trim().toLowerCase();
  return Boolean(
    fillPaint &&
      (node.attrs.fillOpaque === "true" || isOpaqueFillToken(fillPaint)) &&
      fill > 0.99,
  );
};

const hasVisibleStrokePaint = (node: ModuleSemanticNode) => {
  const { stroke } = readOpacityProduct(node);
  const strokePaint = node.attrs.stroke?.trim().toLowerCase();
  return Boolean(
    strokePaint &&
      strokePaint !== "none" &&
      strokePaint !== "transparent" &&
      stroke > 0.01,
  );
};

const isOpaqueCoveringLayer = (node: ModuleSemanticNode) => {
  const { opacity } = readOpacityProduct(node);
  return opacity > 0.99 && !hasLayerSideEffects(node) && hasOpaqueFillPaint(node);
};

const geometryFingerprint = (node: ModuleSemanticNode) => {
  const attrs = node.attrs;
  return [
    node.tag,
    attrs.pathDataHash ?? "",
    attrs.pathDataLength ?? "",
    attrs["fill-rule"] ?? "",
    attrs.width ?? "",
    attrs.height ?? "",
    attrs.x ?? "",
    attrs.y ?? "",
    attrs.rx ?? "",
    attrs.ry ?? "",
    attrs.r ?? "",
    attrs.cx ?? "",
    attrs.cy ?? "",
    attrs["stroke-width"] ?? "",
  ].join("|");
};

const canTreatAsSameGeometryLayer = (
  lower: ModuleSemanticNode,
  upper: ModuleSemanticNode,
) => {
  if (lower.id === upper.id) return false;
  if (lower.parentId !== upper.parentId) return false;
  if (lower.tag !== upper.tag) return false;
  if (lower.childIds.length > 0 || upper.childIds.length > 0) return false;
  if (!boxesMatch(lower.bbox, upper.bbox)) return false;
  if (hasLayerSideEffects(lower) || hasLayerSideEffects(upper)) return false;
  if (hasVisibleStrokePaint(lower)) return false;
  return geometryFingerprint(lower) === geometryFingerprint(upper);
};

const detectCoveredRedundantNodeIds = (nodes: ModuleSemanticNode[]) => {
  const byParent = new Map<string, ModuleSemanticNode[]>();
  const coveredShapeTags = new Set([
    "circle",
    "ellipse",
    "path",
    "polygon",
    "polyline",
    "rect",
  ]);
  for (const node of nodes) {
    if (!node.visible || !node.bbox) continue;
    if (!coveredShapeTags.has(node.tag)) continue;
    const parentKey = node.parentId ?? "__root__";
    const siblings = byParent.get(parentKey);
    if (siblings) {
      siblings.push(node);
    } else {
      byParent.set(parentKey, [node]);
    }
  }

  const redundantNodeIds = new Set<string>();
  for (const siblings of byParent.values()) {
    const ordered = siblings
      .slice()
      .sort((left, right) => left.siblingIndex - right.siblingIndex);
    for (let upperIndex = 1; upperIndex < ordered.length; upperIndex += 1) {
      const upper = ordered[upperIndex]!;
      if (!isOpaqueCoveringLayer(upper)) continue;
      for (let lowerIndex = upperIndex - 1; lowerIndex >= 0; lowerIndex -= 1) {
        const lower = ordered[lowerIndex]!;
        if (redundantNodeIds.has(lower.id)) continue;
        if (canTreatAsSameGeometryLayer(lower, upper)) {
          redundantNodeIds.add(lower.id);
        }
      }
    }
  }
  return redundantNodeIds;
};

const normalizeSemanticNodes = (nodes: ModuleSemanticNode[]) => {
  let didChange = false;
  const zeroAreaNodeIds = new Set<string>();

  const normalizedNodes = nodes.map((node) => {
    const normalizedBox = hasMeaningfulBox(node.bbox) ? node.bbox : undefined;
    if (node.bbox && !normalizedBox) {
      zeroAreaNodeIds.add(node.id);
    }
    const visible = Boolean(normalizedBox);
    if (normalizedBox === node.bbox && node.visible === visible) {
      return node;
    }
    didChange = true;
    return {
      ...node,
      bbox: normalizedBox,
      visible,
    };
  });

  const removableNodeIds = detectCoveredRedundantNodeIds(normalizedNodes);

  let removedInPass = true;
  while (removedInPass) {
    removedInPass = false;
    for (const node of normalizedNodes) {
      if (!zeroAreaNodeIds.has(node.id) || removableNodeIds.has(node.id)) continue;
      if (node.childIds.every((childId) => removableNodeIds.has(childId))) {
        removableNodeIds.add(node.id);
        removedInPass = true;
      }
    }
  }

  if (removableNodeIds.size === 0) {
    return didChange ? normalizedNodes : nodes;
  }

  didChange = true;
  return normalizedNodes.flatMap<ModuleSemanticNode>((node) => {
    if (removableNodeIds.has(node.id)) {
      return [];
    }
    const childIds = node.childIds.filter((childId) => !removableNodeIds.has(childId));
    if (childIds.length === node.childIds.length) {
      return [node];
    }
    return [
      {
        ...node,
        childIds,
      },
    ];
  });
};

const summarizeSemanticNodes = ({
  nodes,
  rootAttrs,
}: {
  nodes: ModuleSemanticNode[];
  rootAttrs: ModuleSemanticNodeAttrs;
}) => ({
  nodeCount: nodes.length,
  rootAttrs,
  tagCounts: nodes.reduce<Record<string, number>>((counts, node) => {
    counts[node.tag] = (counts[node.tag] ?? 0) + 1;
    return counts;
  }, {}),
  textNodeCount: nodes.filter(
    (node) => typeof node.textContent === "string" && node.textContent.trim().length > 0,
  ).length,
  visibleNodeCount: nodes.filter((node) => node.visible).length,
});

const normalizeSemanticGeneratedAssets = (
  document: unknown,
): ModuleOutputAllowedAsset[] => {
  if (!isRecord(document) || !Array.isArray(document.generatedAssets)) return [];
  return document.generatedAssets.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const ref =
      readString(entry.path) ??
      readString(entry.relativePath) ??
      readString(entry.htmlRef) ??
      readString(entry.assetPath);
    if (!ref) return [];
    const assetName = path.basename(ref);
    return [
      {
        ...entry,
        assetId: readString(entry.assetId) ?? readString(entry.id),
        assetKind:
          readString(entry.assetKind) ??
          readString(entry.kind) ??
          "module-semantic-generated",
        assetName: readString(entry.assetName) ?? assetName,
        box:
          isRecord(entry.box) &&
          readNumber(entry.box.x) !== undefined &&
          readNumber(entry.box.y) !== undefined &&
          readNumber(entry.box.width) !== undefined &&
          readNumber(entry.box.height) !== undefined
            ? {
                height: readNumber(entry.box.height)!,
                width: readNumber(entry.box.width)!,
                x: readNumber(entry.box.x)!,
                y: readNumber(entry.box.y)!,
              }
            : undefined,
        htmlRef: readString(entry.htmlRef) ?? ref,
        path: readString(entry.path) ?? ref,
        relativePath: readString(entry.relativePath) ?? ref,
        source:
          readString(entry.source) ?? "module-agent.export-svg-node-asset",
        textTreatment: readString(entry.textTreatment) ?? "unknown",
      } satisfies ModuleOutputAllowedAsset,
    ];
  });
};

const fileMtimeMs = async (filePath: string) => {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return undefined;
  }
};

const isUpToDate = async ({
  outputPath,
  sourcePath,
}: {
  outputPath: string;
  sourcePath: string;
}) => {
  const [outputMtime, sourceMtime] = await Promise.all([
    fileMtimeMs(outputPath),
    fileMtimeMs(sourcePath),
  ]);
  return (
    outputMtime !== undefined &&
    sourceMtime !== undefined &&
    outputMtime + 1 >= sourceMtime
  );
};

const hasCurrentSemanticDocument = (
  value: unknown,
): value is ModuleSemanticDocument =>
  isRecord(value) &&
  isRecord(value.runtime) &&
  value.runtime.schemaVersion === MODULE_SEMANTIC_SCHEMA_VERSION &&
  value.runtime.nodeFactVersion === MODULE_SEMANTIC_NODE_FACT_VERSION &&
  value.runtime.semanticPassVersion === MODULE_SEMANTIC_SEMANTIC_PASS_VERSION &&
  value.runtime.textStylePassVersion === MODULE_SEMANTIC_TEXT_STYLE_PASS_VERSION &&
  Array.isArray(value.nodes) &&
  value.nodes.every(
    (node) =>
      isRecord(node) &&
      typeof node.id === "string" &&
      typeof node.nodePath === "string" &&
      typeof node.inspectIndex === "number" &&
      isRecord(node.semantic),
  ) &&
  isRecord(value.sourceImage) &&
  typeof value.sourceImage.path === "string";

const RENDER_READY_SCRIPT = `<script>
      (async () => {
        try {
          await Promise.all(
            Array.from(document.images).map((img) =>
              img.decode ? img.decode().catch(() => {}) : Promise.resolve(),
            ),
          );
        } catch {}
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__RENDER_READY__ = true;
        }));
      })();
    </script>`;

const createModuleReferenceWrapper = ({
  height,
  moduleSvgPath,
  width,
}: {
  height: number;
  moduleSvgPath: string;
  width: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      img {
        display: block;
        width: ${width}px;
        height: ${height}px;
      }
    </style>
  </head>
  <body data-module-reference-render-version="${MODULE_REFERENCE_RENDER_VERSION}">
    <img src="${pathToFileURL(moduleSvgPath).href}" alt="" />
    ${RENDER_READY_SCRIPT}
  </body>
</html>`;

const createSharedUnderlayWrapper = ({
  moduleHeight,
  moduleWidth,
  offsetX,
  offsetY,
  sharedHeight,
  sharedUnderlaySvgPath,
  sharedWidth,
}: {
  moduleHeight: number;
  moduleWidth: number;
  offsetX: number;
  offsetY: number;
  sharedHeight: number;
  sharedUnderlaySvgPath: string;
  sharedWidth: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0;
        width: ${moduleWidth}px;
        height: ${moduleHeight}px;
        overflow: hidden;
        background: transparent;
      }
      .underlay {
        position: absolute;
        top: -${offsetY}px;
        left: -${offsetX}px;
        width: ${sharedWidth}px;
        height: ${sharedHeight}px;
      }
    </style>
  </head>
  <body>
    <img class="underlay" src="${pathToFileURL(sharedUnderlaySvgPath).href}" alt="" />
    ${RENDER_READY_SCRIPT}
  </body>
</html>`;

const createCompositeWrapper = ({
  moduleHeight,
  moduleSvgPath,
  moduleWidth,
  offsetX,
  offsetY,
  sharedHeight,
  sharedUnderlaySvgPath,
  sharedWidth,
}: {
  moduleHeight: number;
  moduleSvgPath: string;
  moduleWidth: number;
  offsetX: number;
  offsetY: number;
  sharedHeight: number;
  sharedUnderlaySvgPath: string;
  sharedWidth: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body {
        margin: 0;
        width: ${moduleWidth}px;
        height: ${moduleHeight}px;
        overflow: hidden;
        background: transparent;
      }
      .underlay {
        position: absolute;
        top: -${offsetY}px;
        left: -${offsetX}px;
        width: ${sharedWidth}px;
        height: ${sharedHeight}px;
      }
      .module {
        position: absolute;
        top: 0;
        left: 0;
        width: ${moduleWidth}px;
        height: ${moduleHeight}px;
      }
    </style>
  </head>
  <body>
    <img class="underlay" src="${pathToFileURL(sharedUnderlaySvgPath).href}" alt="" />
    <img class="module" src="${pathToFileURL(moduleSvgPath).href}" alt="" />
    ${RENDER_READY_SCRIPT}
  </body>
</html>`;

const ensureModuleReferenceImage = async ({
  moduleDir,
  moduleSvgPath,
  scale,
}: {
  moduleDir: string;
  moduleSvgPath: string;
  scale: number;
}) => {
  const sourceImagePath = path.join(moduleDir, "module-reference.png");
  const wrapperPath = path.join(moduleDir, "module-reference-source.html");
  const hasCurrentWrapperVersion = async () => {
    try {
      const wrapperMarkup = await readFile(wrapperPath, "utf8");
      return wrapperMarkup.includes(
        `data-module-reference-render-version="${MODULE_REFERENCE_RENDER_VERSION}"`,
      );
    } catch {
      return false;
    }
  };
  if (
    (await isUpToDate({ outputPath: sourceImagePath, sourcePath: moduleSvgPath })) &&
    (await isUpToDate({ outputPath: sourceImagePath, sourcePath: wrapperPath })) &&
    (await hasCurrentWrapperVersion())
  ) {
    const { height, width } = await parseSvgSize(moduleSvgPath, scale);
    return { height, sourceImagePath, width };
  }

  const { height, width } = await parseSvgSize(moduleSvgPath, scale);
  await writeTextFile(
    wrapperPath,
    createModuleReferenceWrapper({
      height,
      moduleSvgPath,
      width,
    }),
  );

  const browser = await launchEdge();
  try {
    await capturePage({
      deviceScaleFactor: PNG_RASTER_SCALE_MULTIPLIER,
      outputPath: sourceImagePath,
      port: browser.port,
      transparentBackground: true,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: height,
      viewportWidth: width,
    });
  } finally {
    await browser.close();
  }

  return { height, sourceImagePath, width };
};

const ensureModuleContextImages = async ({
  moduleDir,
  module,
  moduleSvgPath,
  sharedLayers,
  scale,
}: {
  moduleDir: string;
  module: SvgVerticalModule;
  moduleSvgPath: string;
  sharedLayers: Array<{
    kind: "shared-underlay";
    region?: { x: number; y: number; width: number; height: number };
    svgPath?: string;
  }>;
  scale: number;
}): Promise<{ compositePath: string | undefined; sharedUnderlayPath: string | undefined }> => {
  const sharedUnderlayLayer = sharedLayers.find(
    (layer) =>
      layer.kind === "shared-underlay" &&
      layer.svgPath &&
      layer.region &&
      layer.region.x < module.region.x + module.region.width &&
      layer.region.x + layer.region.width > module.region.x &&
      layer.region.y < module.region.y + module.region.height &&
      layer.region.y + layer.region.height > module.region.y,
  );
  if (!sharedUnderlayLayer || !sharedUnderlayLayer.svgPath || !sharedUnderlayLayer.region) {
    return { compositePath: undefined, sharedUnderlayPath: undefined };
  }

  const sharedUnderlaySvgPath = sharedUnderlayLayer.svgPath;
  const compositeOutputPath = path.join(moduleDir, "composite.png");
  const sharedUnderlayOutputPath = path.join(moduleDir, "shared-underlay.png");

  const [compositeUpToDate, underlayUpToDate] = await Promise.all([
    isUpToDate({ outputPath: compositeOutputPath, sourcePath: moduleSvgPath }),
    isUpToDate({ outputPath: sharedUnderlayOutputPath, sourcePath: moduleSvgPath }),
  ]);

  if (compositeUpToDate && underlayUpToDate) {
    return { compositePath: compositeOutputPath, sharedUnderlayPath: sharedUnderlayOutputPath };
  }

  const [{ width: moduleWidth, height: moduleHeight }, { width: sharedWidth, height: sharedHeight }] =
    await Promise.all([
      parseSvgSize(moduleSvgPath, scale),
      parseSvgSize(sharedUnderlaySvgPath, scale),
    ]);

  const offsetX = module.region.x - sharedUnderlayLayer.region.x;
  const offsetY = module.region.y - sharedUnderlayLayer.region.y;

  const sharedUnderlayWrapperPath = path.join(moduleDir, "shared-underlay-source.html");
  const compositeWrapperPath = path.join(moduleDir, "composite-source.html");

  await Promise.all([
    writeTextFile(
      sharedUnderlayWrapperPath,
      createSharedUnderlayWrapper({
        moduleHeight,
        moduleWidth,
        offsetX,
        offsetY,
        sharedHeight,
        sharedUnderlaySvgPath,
        sharedWidth,
      }),
    ),
    writeTextFile(
      compositeWrapperPath,
      createCompositeWrapper({
        moduleHeight,
        moduleSvgPath,
        moduleWidth,
        offsetX,
        offsetY,
        sharedHeight,
        sharedUnderlaySvgPath,
        sharedWidth,
      }),
    ),
  ]);

  const browser = await launchEdge();
  try {
    // Capture sequentially (not Promise.all): concurrent capturePage calls on
    // the same pooled browser instance can bleed frames across targets, which
    // shows up as several images stacked together in composite.png. Opaque
    // background forces a surface clear per capture as an extra safeguard.
    await capturePage({
      deviceScaleFactor: PNG_RASTER_SCALE_MULTIPLIER,
      opaqueBackground: true,
      outputPath: sharedUnderlayOutputPath,
      port: browser.port,
      url: pathToFileURL(sharedUnderlayWrapperPath).href,
      viewportHeight: moduleHeight,
      viewportWidth: moduleWidth,
    });
    await capturePage({
      deviceScaleFactor: PNG_RASTER_SCALE_MULTIPLIER,
      opaqueBackground: true,
      outputPath: compositeOutputPath,
      port: browser.port,
      url: pathToFileURL(compositeWrapperPath).href,
      viewportHeight: moduleHeight,
      viewportWidth: moduleWidth,
    });
  } finally {
    await browser.close();
  }

  return { compositePath: compositeOutputPath, sharedUnderlayPath: sharedUnderlayOutputPath };
};

const buildNodeIdsByPath = (nodePaths: string[]) =>
  new Map(
    nodePaths.map((nodePath, index) => [
      nodePath,
      `n${String(index + 1).padStart(4, "0")}`,
    ]),
  );

const createModuleSemanticDraft = async ({
  module,
  moduleDir,
  moduleSvgPath,
  scale,
}: CreateModuleSemanticDraftInput): Promise<CreateModuleSemanticDraftResult> => {
  const jsonPath = path.join(moduleDir, "module-semantic.json");
  if (await isUpToDate({ outputPath: jsonPath, sourcePath: moduleSvgPath })) {
    try {
      const existing = JSON.parse(await readFile(jsonPath, "utf8")) as unknown;
      if (hasCurrentSemanticDocument(existing)) {
        return {
          document: existing,
          jsonPath,
          sourceImagePath: path.join(
            moduleDir,
            existing.sourceImage.path.replaceAll("/", path.sep),
          ),
        };
      }
    } catch {
      // Corrupt cache files are regenerated below.
    }
  }

  const [{ height, sourceImagePath, width }, svgMarkup] = await Promise.all([
    ensureModuleReferenceImage({ moduleDir, moduleSvgPath, scale }),
    readFile(moduleSvgPath, "utf8"),
  ]);

  const { result } = await readSvgLayout({
    design: {
      designName: `${module.id}-semantic`,
      height,
      scale,
      svgPath: moduleSvgPath,
      width,
    },
    svgMarkup,
    wrapperName: "module-semantic-svg-layout.html",
    wrapperRoot: moduleDir,
  });

  const nodeIdsByPath = buildNodeIdsByPath(result.nodes.map((node) => node.nodePath));
  const childIdsByParent = new Map<string, string[]>();
  result.nodes.forEach((node) => {
    if (!node.parentPath) return;
    const parentId = nodeIdsByPath.get(node.parentPath);
    const nodeId = nodeIdsByPath.get(node.nodePath);
    if (!parentId || !nodeId) return;
    const next = childIdsByParent.get(parentId) ?? [];
    next.push(nodeId);
    childIdsByParent.set(parentId, next);
  });

  const draftNodes: ModuleSemanticNode[] = result.nodes.map((node, inspectIndex) => {
    const id = nodeIdsByPath.get(node.nodePath);
    if (!id) throw new Error(`Missing semantic node id for ${node.nodePath}`);
    const parentId = node.parentPath ? nodeIdsByPath.get(node.parentPath) ?? null : null;
    const pixelBox = node.pixelBox ?? undefined;
    const bbox = hasMeaningfulBox(pixelBox) ? pixelBox : undefined;
    const visibleBox =
      node.visibleBox && hasMeaningfulBox(node.visibleBox)
        ? node.visibleBox
        : undefined;
    return {
      attrs: pickImportantAttrs(node.attributes),
      bbox,
      childIds: childIdsByParent.get(id) ?? [],
      depth: node.depth,
      id,
      inspectIndex,
      nodePath: node.nodePath,
      parentId,
      semantic: {
        containsReadableText:
          typeof node.textContent === "string" && node.textContent.trim().length > 0,
        exportDecision: "pending",
        kind: "unknown",
        text: node.textContent,
        textHandling: "pending",
        ...(typeof node.textContent === "string" && node.textContent.trim().length > 0
          ? { textKind: "svg-text" }
          : {}),
      },
      selector: nodePathToSelector(node.nodePath),
      siblingIndex: node.siblingIndex,
      tag: node.tag,
      textContent: node.textContent,
      viewBoxBox: node.viewBoxBox ?? undefined,
      visible: Boolean(bbox),
      ...(visibleBox ? { visibleBox } : {}),
    };
  });
  const nodes = normalizeSemanticNodes(draftNodes);
  const rootNode = result.nodes[0];

  const document: ModuleSemanticDocument = {
    analysisSheets: [],
    generatedAssets: [],
    module: {
      id: module.id,
      kind: module.kind,
      region: module.region,
      scale,
    },
    nodes,
    runtime: {
      completedStages: ["node-facts", "reference-image"],
      nodeFactVersion: MODULE_SEMANTIC_NODE_FACT_VERSION,
      referenceRenderVersion: MODULE_REFERENCE_RENDER_VERSION,
      schemaVersion: MODULE_SEMANTIC_SCHEMA_VERSION,
      semanticPassVersion: MODULE_SEMANTIC_SEMANTIC_PASS_VERSION,
      textStylePassVersion: MODULE_SEMANTIC_TEXT_STYLE_PASS_VERSION,
    },
    sourceImage: {
      height,
      id: "module-reference",
      path: toRelativeModulePath(moduleDir, sourceImagePath),
      readableByAgent: true,
      width,
    },
    svgSummary: summarizeSemanticNodes({
      nodes,
      rootAttrs: pickImportantAttrs(rootNode?.attributes ?? {}),
    }),
    textBlocks: [],
  };

  await writeJsonFile(jsonPath, document);
  return {
    document,
    jsonPath,
    sourceImagePath,
  };
};

const readModuleSemanticDocument = async (
  moduleDir: string,
): Promise<ModuleSemanticDocument | null> => {
  const jsonPath = path.join(moduleDir, "module-semantic.json");
  try {
    return JSON.parse(await readFile(jsonPath, "utf8")) as ModuleSemanticDocument;
  } catch {
    return null;
  }
};

// Attrs whitelist for agent-facing compact output. Only fields that provide
// direct CSS decision value (colors, opacity) or semantic grouping hints.
// All geometry (cx/cy/r/x/y/width/height/transform), text styling
// (font-*/computed-font-*/letter-spacing/dominant-baseline/text-anchor),
// most SVG internals (pathDataLength/href/xlink:href),
// and display/visibility (already filtered by isVisibleNode) are excluded
// because they are either redundant with bbox/textBlocks.styleInference or
// meaningless without SVG defs context.
const AGENT_COMPACT_ATTRS = new Set([
  "class",
  "fill",
  "fill-opacity",
  "opacity",
  "stroke",
  "stroke-opacity",
]);

const AGENT_VISUAL_REFERENCE_ATTRS = new Set([
  "clip-path",
  "filter",
  "mask",
]);

const URL_REFERENCE_RE = /^url\(/i;

const hasAgentVisualReferenceAttrs = (node: ModuleSemanticNode) =>
  node.attrs != null &&
  [...AGENT_VISUAL_REFERENCE_ATTRS].some((key) => {
    const value = node.attrs[key];
    return typeof value === "string" && value.trim().length > 0 && value !== "none";
  });

const pickAgentAttrs = (
  attrs: ModuleSemanticNodeAttrs,
  options: { includeVisualReferenceAttrs?: boolean } = {},
): ModuleSemanticNodeAttrs | null => {
  const next: ModuleSemanticNodeAttrs = {};
  let hasEntries = false;
  for (const [key, value] of Object.entries(attrs)) {
    const isVisualReferenceAttr = AGENT_VISUAL_REFERENCE_ATTRS.has(key);
    if (
      !AGENT_COMPACT_ATTRS.has(key) &&
      !(options.includeVisualReferenceAttrs && isVisualReferenceAttr)
    ) {
      continue;
    }
    if (typeof value !== "string") continue;
    // Skip url() references (e.g. "url(#gradient-1)") — meaningless without SVG defs
    if (URL_REFERENCE_RE.test(value) && !isVisualReferenceAttr) continue;
    // Skip base64 data URIs
    if (value.startsWith("data:") && value.includes("base64,")) continue;
    // Skip "none" values — no informational value
    if (value === "none") continue;
    next[key] = value;
    hasEntries = true;
  }
  return hasEntries ? next : null;
};

// Compact the semantic document for agent consumption. Based on trace analysis
// across 8 modules (2 sessions), the fields removed here had 0 reasoning
// references or were 100% redundant with kept fields. Diagnostic data is
// preserved in module-semantic.debug.json (written before this runs).
//
// Optimization notes (2026-06):
// - attrs: reduced from 33-field IMPORTANT_ATTRS to 6-field AGENT_COMPACT_ATTRS;
//   visual refs (mask/filter/clip-path) are kept only on affected nodes because
//   they change pixels and asset export choices.
// - skip nodes: kept with minimal fields (id/tag/bbox/inspectIndex/semantic) for
//   z-order context unless they carry visual refs.
// - export nodes: full compact treatment with visibleBox/visualEffects retained.
const compactDocumentForAgent = <T extends { nodes: ModuleSemanticNode[] }>(
  document: T,
): T => {
  const isVisibleNode = (node: ModuleSemanticNode) =>
    node.visible === true ||
    (node.visible !== false && hasMeaningfulBox(node.bbox));

  const compactSemantic = (node: ModuleSemanticNode) => ({
    exportDecision: node.semantic.exportDecision,
    kind: node.semantic.kind,
    textHandling: node.semantic.textHandling,
    ...(typeof node.semantic.containsReadableText === "boolean"
      ? { containsReadableText: node.semantic.containsReadableText }
      : {}),
    ...(node.semantic.text ? { text: node.semantic.text } : {}),
    ...(node.semantic.textKind
      ? { textKind: node.semantic.textKind }
      : {}),
    ...(node.semantic.contentType
      ? { contentType: node.semantic.contentType }
      : {}),
  });

  const compactedNodes = document.nodes
    .filter(isVisibleNode)
    .map((node) => {
      const isSkipNode = node.semantic.exportDecision === "skip";
      const hasVisualReferenceAttrs = hasAgentVisualReferenceAttrs(node);

      // Skip nodes: minimal footprint — only id/tag/bbox/inspectIndex/semantic.
      // They provide z-order context for text layering but don't need attrs,
      // selector, visibleBox, or visualEffects (agent never exports/styles them).
      if (isSkipNode && !hasVisualReferenceAttrs) {
        return {
          id: node.id,
          tag: node.tag,
          ...(node.childIds?.length ? { childIds: node.childIds } : {}),
          ...(node.bbox ? { bbox: node.bbox } : {}),
          inspectIndex: node.inspectIndex,
          semantic: compactSemantic(node),
        };
      }

      // Export nodes: full compact treatment with trimmed attrs.
      const agentAttrs = node.attrs
        ? pickAgentAttrs(node.attrs, {
            includeVisualReferenceAttrs: hasVisualReferenceAttrs,
          })
        : null;
      return {
        id: node.id,
        tag: node.tag,
        ...(node.childIds?.length ? { childIds: node.childIds } : {}),
        ...(agentAttrs ? { attrs: agentAttrs } : {}),
        ...(node.bbox ? { bbox: node.bbox } : {}),
        inspectIndex: node.inspectIndex,
        semantic: compactSemantic(node),
        ...(node.visibleBox ? { visibleBox: node.visibleBox } : {}),
        ...(node.visualEffects?.length
          ? { visualEffects: node.visualEffects }
          : {}),
      };
    });

  const result = {
    ...document,
    nodes: compactedNodes,
  } as Record<string, unknown>;

  // Diagnostic-only top-level fields (kept in module-semantic.debug.json).
  // svgNodeAssets/textResources/textAppearanceHints had 0 useful reasoning
  // refs; svgNodeAssets actively distracted the agent (2 refs both "looked
  // and ignored"); textAppearanceHints duplicated styleInference and confused
  // the agent about color source. guidance/inputContract duplicated the prompt
  // and inputContract.focusOrder misdirected the agent to redundant arrays.
  delete result.analysisSheets;
  delete result.runtime;
  delete result.textContentBlocks;
  delete result.visualTextElements;
  delete result.textGeometryDisagreements;
  delete result.svgTextNodes;
  delete result.svgNodeAssets;
  delete result.textResources;
  delete result.textAppearanceHints;
  delete result.guidance;
  delete result.inputContract;
  delete result.summaryStats;
  delete result.graphicAssets;
  delete result.summaryVersion;

  // Compact textBlocks: keep only {id, text, color?,
  // layoutTargetRegion, styleInference}. Verified across 8 modules / 48 blocks:
  // region==textRegion, renderedTextRegion==layoutTargetRegion,
  // sourceBlockText==text, sourceBlockId==id (all 100% identical, 0 refs).
  if (Array.isArray(result.textBlocks)) {
    result.textBlocks = (result.textBlocks as ModuleSemanticTextBlock[]).map(
      (block) => {
        const compacted: Record<string, unknown> = {
          id: block.id,
          text: block.text,
          ...(block.styleInference
            ? { styleInference: block.styleInference }
            : {}),
        };
        // layoutTargetRegion is the authoritative DOM container box
        // (documented in prompt + layoutTargetRule). Falls back to region
        // only if layoutTargetRegion is missing.
        const layoutBox = block.layoutTargetRegion ?? block.region;
        if (layoutBox) compacted.layoutTargetRegion = layoutBox;
        if (block.color) compacted.color = block.color;
        return compacted;
      },
    );
  }

  if (isRecord(result.svgSummary)) {
    const svgSummary = result.svgSummary as Record<string, unknown>;
    delete svgSummary.elementSamples;
    delete svgSummary.tagCounts;
    if (Array.isArray(svgSummary.textSamples) && svgSummary.textSamples.length === 0) {
      delete svgSummary.textSamples;
    }
  }

  return result as T;
};

const writeModuleSemanticDocument = async ({
  document,
  moduleDir,
}: {
  document: ModuleSemanticDocument;
  moduleDir: string;
}) => {
  const jsonPath = path.join(moduleDir, "module-semantic.json");
  await writeJsonFile(jsonPath, document);
  return jsonPath;
};

const moduleSemanticLocks = new Map<string, Promise<void>>();

// Cross-process lock: parallel `pnpm exec tsx export-svg-node-asset.ts`
// invocations each run in their own Node process, so the in-process
// `moduleSemanticLocks` Map cannot serialize their read-modify-write of
// module-semantic.json. A lock file with O_EXCL atomic create + stale
// detection makes the read-modify-write safe across processes. The slow
// browser render/capture happens before `updateModuleSemanticDocument` is
// called, so parallel exports still run their browser work concurrently;
// only the quick JSON write is serialized.
const MODULE_SEMANTIC_LOCK_STALE_MS = 30_000;
const MODULE_SEMANTIC_LOCK_TIMEOUT_MS = 10_000;
const MODULE_SEMANTIC_LOCK_RETRY_MS = 50;

const sleepLock = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const acquireModuleSemanticLock = async (lockPath: string): Promise<void> => {
  const startedAt = Date.now();
  const token = `${process.pid}\n${startedAt}\n`;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(token);
      await handle.close();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > MODULE_SEMANTIC_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // lock file disappeared between open and stat — retry
      }
      if (Date.now() - startedAt > MODULE_SEMANTIC_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out acquiring module-semantic lock: ${lockPath}`,
        );
      }
      await sleepLock(MODULE_SEMANTIC_LOCK_RETRY_MS);
    }
  }
};

const releaseModuleSemanticLock = async (lockPath: string): Promise<void> => {
  await unlink(lockPath).catch(() => {});
};

const updateModuleSemanticDocument = async ({
  moduleDir,
  updater,
}: {
  moduleDir: string;
  updater: (document: ModuleSemanticDocument) => ModuleSemanticDocument;
}) => {
  const normalizedDir = path.resolve(moduleDir);
  const prev = moduleSemanticLocks.get(normalizedDir) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  moduleSemanticLocks.set(normalizedDir, next);
  const lockPath = path.join(normalizedDir, "module-semantic.json.lock");

  try {
    await prev;
    await acquireModuleSemanticLock(lockPath);
    try {
      const document = await readModuleSemanticDocument(normalizedDir);
      if (!document) {
        throw new Error(`module-semantic.json not found in ${normalizedDir}`);
      }
      const nextDocument = updater(document);
      await writeModuleSemanticDocument({
        document: nextDocument,
        moduleDir: normalizedDir,
      });
      return nextDocument;
    } finally {
      await releaseModuleSemanticLock(lockPath);
    }
  } finally {
    release!();
    if (moduleSemanticLocks.get(normalizedDir) === next) {
      moduleSemanticLocks.delete(normalizedDir);
    }
  }
};

const buildModuleSemanticTextHints = (
  document: ModuleSemanticDocument,
) => {
  const textBlockColorById = new Map(
    document.textBlocks.flatMap((block) => {
      const color = readExplicitPaint(block.color);
      return color ? [[block.id, color] as const] : [];
    }),
  );

  return {
    blocks: document.nodes.flatMap((node) => {
      const text =
        readString(node.semantic.text) ?? readString(node.textContent) ?? undefined;
      if (node.semantic.textHandling !== "dom-text" || !node.bbox || !text) return [];
      return [
        {
          bbox: node.bbox,
          color:
            readExplicitPaint(node.attrs?.fill) ?? textBlockColorById.get(node.id),
          id: node.id,
          lineCount: node.semantic.lineCount,
          lines: node.semantic.visualLines,
          role: node.semantic.textKind ?? node.semantic.kind,
          text,
        },
      ];
    }),
  };
};

const readModuleAllowedAssets = async (
  moduleDir: string,
): Promise<ModuleOutputAllowedAsset[]> => {
  const document = await readModuleSemanticDocument(moduleDir);
  return normalizeSemanticGeneratedAssets(document);
};

export { createModuleSemanticDraft, ensureModuleContextImages, ensureModuleReferenceImage };
export type {
  ModuleSemanticAnalysisSheet,
  ModuleSemanticDocument,
  ModuleSemanticGeneratedAsset,
  ModuleSemanticNode,
  ModuleSemanticNodeSemantic,
  ModuleSemanticTextBlock,
  ModuleSemanticVisualEffect,
};
export {
  buildModuleSemanticTextHints,
  compactDocumentForAgent,
  readModuleAllowedAssets,
  readModuleSemanticDocument,
  readString,
  updateModuleSemanticDocument,
  writeModuleSemanticDocument,
};
