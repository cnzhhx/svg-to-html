import { readFile, stat } from "node:fs/promises";
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
};

type ModuleSemanticTextBlock = {
  color?: string;
  id: string;
  kind?: string;
  lineRegions?: Box[];
  lines?: Array<{ region: Box; text?: string }>;
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
const MODULE_SEMANTIC_NODE_FACT_VERSION = 2;
const MODULE_SEMANTIC_SEMANTIC_PASS_VERSION = 3;
const MODULE_SEMANTIC_TEXT_STYLE_PASS_VERSION = 4;

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
  "fill-opacity",
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
  "pathDataLength",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-opacity",
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

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pickImportantAttrs = (attrs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(attrs).filter(([name]) => IMPORTANT_ATTRS.has(name)),
  );

const nodePathToSelector = (nodePath: string) => {
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

  if (zeroAreaNodeIds.size === 0) {
    return didChange ? normalizedNodes : nodes;
  }

  const removableNodeIds = new Set<string>();
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
    kind: "shared-underlay" | "shared-overlay";
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

const stripBase64Attrs = (attrs: ModuleSemanticNodeAttrs): ModuleSemanticNodeAttrs => {
  const next: ModuleSemanticNodeAttrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (
      typeof value === "string" &&
      value.startsWith("data:") &&
      value.includes("base64,")
    ) {
      continue;
    }
    next[key] = value;
  }
  return next;
};

const compactDocumentForAgent = <T extends { nodes: ModuleSemanticNode[] }>(
  document: T,
): T => {
  const isVisibleNode = (node: ModuleSemanticNode) =>
    node.visible === true ||
    (node.visible !== false && hasMeaningfulBox(node.bbox));
  const visibleNodeIds = new Set(
    document.nodes.filter(isVisibleNode).map((n) => n.id),
  );

  const compactedNodes = document.nodes
    .filter(isVisibleNode)
    .map((node) => ({
      id: node.id,
      tag: node.tag,
      attrs: stripBase64Attrs(node.attrs),
      bbox: node.bbox,
      childIds: node.childIds.filter((id) => visibleNodeIds.has(id)),
      depth: node.depth,
      inspectIndex: node.inspectIndex,
      nodePath: node.nodePath,
      parentId:
        node.parentId && visibleNodeIds.has(node.parentId)
          ? node.parentId
          : null,
      ...(node.selector ? { selector: node.selector } : {}),
      semantic: {
        exportDecision: node.semantic.exportDecision,
        kind: node.semantic.kind,
        textHandling: node.semantic.textHandling,
        ...(typeof node.semantic.containsReadableText === "boolean"
          ? { containsReadableText: node.semantic.containsReadableText }
          : {}),
        ...(node.semantic.text ? { text: node.semantic.text } : {}),
        ...(typeof node.semantic.lineCount === "number" &&
        Number.isFinite(node.semantic.lineCount) &&
        node.semantic.lineCount >= 1
          ? { lineCount: Math.round(node.semantic.lineCount) }
          : {}),
        ...(node.semantic.textKind ? { textKind: node.semantic.textKind } : {}),
        ...(node.semantic.contentType ? { contentType: node.semantic.contentType } : {}),
      },
      siblingIndex: node.siblingIndex,
      visible: true,
      ...(node.visibleBox ? { visibleBox: node.visibleBox } : {}),
      ...(node.visualEffects?.length
        ? { visualEffects: node.visualEffects }
        : {}),
    }));

  const result = {
    ...document,
    nodes: compactedNodes,
  } as Record<string, unknown>;

  delete result.analysisSheets;
  delete result.runtime;
  delete result.textContentBlocks;
  delete result.visualTextElements;
  delete result.textGeometryDisagreements;
  delete result.svgTextNodes;

  if (isRecord(result.svgNodeAssets)) {
    const svgNodeAssets = result.svgNodeAssets as Record<string, unknown>;
    const elements = Array.isArray(svgNodeAssets.elements)
      ? svgNodeAssets.elements
      : undefined;
    const skipIndices = Array.isArray(svgNodeAssets.skipIndices)
      ? svgNodeAssets.skipIndices
      : undefined;
    if (elements || skipIndices) {
      result.svgNodeAssets = {
        ...(elements ? { elements } : {}),
        ...(skipIndices ? { skipIndices } : {}),
      };
    } else {
      delete result.svgNodeAssets;
    }
  } else {
    delete result.svgNodeAssets;
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

  try {
    await prev;
    const document = await readModuleSemanticDocument(normalizedDir);
    if (!document) {
      throw new Error(`module-semantic.json not found in ${normalizedDir}`);
    }
    const nextDocument = updater(document);
    await writeModuleSemanticDocument({ document: nextDocument, moduleDir: normalizedDir });
    return nextDocument;
  } finally {
    release!();
    if (moduleSemanticLocks.get(normalizedDir) === next) {
      moduleSemanticLocks.delete(normalizedDir);
    }
  }
};

const buildModuleSemanticTextHints = (
  document: ModuleSemanticDocument,
) => ({
  blocks: document.nodes.flatMap((node) => {
    const text =
      readString(node.semantic.text) ?? readString(node.textContent) ?? undefined;
    if (node.semantic.textHandling !== "dom-text" || !node.bbox || !text) return [];
    return [
      {
        bbox: node.bbox,
        id: node.id,
        lineCount: node.semantic.lineCount,
        role: node.semantic.textKind ?? node.semantic.kind,
        text,
      },
    ];
  }),
});

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
