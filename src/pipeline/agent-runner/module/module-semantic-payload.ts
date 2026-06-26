import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  containmentRatio,
  centerOf,
  overlapRatio,
  type Box,
} from "../../../core/geometry.js";
import {
  compactAttrValue,
  inspectSvgSource,
} from "../../../core/svg-inspection.js";
import type { SvgInspection } from "../../../core/svg-inspection.js";
import { readSvgLayout } from "../../../core/svg-layout.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { ResolvedSvgDesign } from "../../../core/design-resolve.js";
import { isRecord } from "../../../core/type-guards.js";
import { writeJsonFile } from "../../../core/file-io.js";
import {
  compactDocumentForAgent,
  type ModuleSemanticNode,
  type ModuleSemanticVisualEffect,
} from "./module-semantic.js";
import {
  EXPORT_SVG_NODE_COMMAND_TEMPLATE,
  INPUT_CONTRACT_INSTRUCTION,
  SEMANTIC_READ_POLICY,
  LAYOUT_TARGET_RULE,
} from "../../../prompts/semantic.js";

type JsonRecord = Record<string, unknown>;


type WriteModuleSemanticPayloadInput = {
  allowedAssets?: unknown;
  basePayload?: JsonRecord;
  elementAnalysis?: {
    elements: Array<{
      bbox: [number, number, number, number];
      classification: string;
      containsText?: boolean;
      dLength: number;
      exportDecision?: string;
      fill: string;
      hasImage: boolean;
      index: number;
      matchedTextBlockIds?: string[];
      matchedTextBlocks?: string[];
      nodeId?: string;
      nodePath?: string;
      semanticText?: string;
      sourceNodeSelector?: string;
      tag: string;
      visionReason?: string;
    }>;
    skipIndices: number[];
  };
  module: SvgVerticalModule;
  moduleDir: string;
  textHints?: unknown;
  scale: number;
  moduleTextBlocks?: unknown;
  moduleTextStyleHints?: unknown;
  moduleSvgPath: string;
};

type SvgDomTextNodeSummary = {
  attrs: Record<string, string>;
  nodePath: string;
  pixelBox?: Box;
  tag: string;
  text: string;
  viewBoxBox?: Box;
};

const MODULE_SEMANTIC_PAYLOAD_VERSION = 4;
const MAX_SVG_DOM_TEXT_NODE_COUNT = 80;
const TEXT_GEOMETRY_IGNORE_MAX_HEIGHT_RATIO = 1.8;
const TEXT_GEOMETRY_IGNORE_MAX_HORIZONTAL_DELTA = 8;
const TEXT_GEOMETRY_IGNORE_MAX_VERTICAL_DELTA = 6;
const TEXT_GEOMETRY_IGNORE_MAX_WIDTH_RATIO = 1.6;



const statOptional = async (filePath: string) => {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
};

const readJsonRecordIfValid = async (filePath: string): Promise<JsonRecord> => {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const compactBox = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const { height, width, x, y } = value;
  return { height, width, x, y };
};

const pickSvgDomTextAttrs = (attrs: Record<string, string>) =>
  Object.fromEntries(
    [
      "x",
      "y",
      "font-size",
      "font-family",
      "font-weight",
      "letter-spacing",
      "text-anchor",
      "dominant-baseline",
      "computed-font-size",
      "computed-font-family",
      "computed-font-weight",
      "computed-letter-spacing",
    ]
      .map((name) => {
        const value = attrs[name];
        return value ? [name, compactAttrValue(name, value)] : undefined;
      })
      .filter((entry): entry is [string, string] => Array.isArray(entry)),
  );

const pickLayoutTargetRegion = ({
  region,
  renderedTextRegion,
  textRegion,
}: {
  region?: Box;
  renderedTextRegion?: Box;
  textRegion?: Box;
}) => renderedTextRegion ?? textRegion ?? region;

const pickLayoutTargetSource = ({
  region,
  renderedTextRegion,
  textRegion,
}: {
  region?: Box;
  renderedTextRegion?: Box;
  textRegion?: Box;
}) => {
  if (renderedTextRegion) return "renderedTextRegion";
  if (textRegion) return "textRegion";
  if (region) return "region";
  return "none";
};

const readNumericBox = (value: unknown): Box | undefined => {
  if (!isRecord(value)) return undefined;
  const x =
    typeof value.x === "number" && Number.isFinite(value.x)
      ? value.x
      : undefined;
  const y =
    typeof value.y === "number" && Number.isFinite(value.y)
      ? value.y
      : undefined;
  const width =
    typeof value.width === "number" && Number.isFinite(value.width)
      ? value.width
      : undefined;
  const height =
    typeof value.height === "number" && Number.isFinite(value.height)
      ? value.height
      : undefined;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { height, width, x, y };
};

const bboxArrayToBox = (
  value: unknown,
): Box | undefined =>
  Array.isArray(value) &&
  value.length >= 4 &&
  value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? {
        height: value[3] as number,
        width: value[2] as number,
        x: value[0] as number,
        y: value[1] as number,
      }
    : undefined;

const overlapRatioOrZero = (left: Box | undefined, right: Box | undefined) =>
  left && right ? overlapRatio(left, right) : 0;

const containmentRatioOrZero = (
  inner: Box | undefined,
  outer: Box | undefined,
) => (inner && outer ? containmentRatio(inner, outer) : 0);

const SIMPLE_FILTER_MAX_OFFSET = 4;
const SIMPLE_FILTER_MAX_OPACITY = 0.35;
const SIMPLE_FILTER_MAX_BLUR = 0.5;
const VISUAL_EFFECT_TARGET_TAGS = new Set([
  "circle",
  "ellipse",
  "path",
  "polygon",
  "polyline",
  "rect",
]);

const parseSvgAttrs = (source: string) => {
  const attrs: Record<string, string> = {};
  const attrPattern =
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(attrPattern)) {
    const name = match[1];
    if (!name) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
};

const readSvgNumber = (value: string | undefined) => {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readSvgNumberList = (value: string | undefined) =>
  typeof value === "string"
    ? value
        .trim()
        .split(/[\s,]+/)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
    : [];

const roundMetric = (value: number) => Number(value.toFixed(3));

const formatCssNumber = (value: number) => {
  const rounded = roundMetric(value);
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const formatCssLength = (value: number) => {
  const rounded = roundMetric(value);
  if (rounded === 0 || Object.is(rounded, -0)) return "0";
  return `${rounded}px`;
};

const clampRgbChannel = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)));

const colorMatrixOffsetToRgb = (matrix: number[]) => {
  const offsets = [matrix[4], matrix[9], matrix[14]].map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0,
  );
  const normalized = offsets.every((value) => Math.abs(value) <= 1)
    ? offsets.map((value) => value * 255)
    : offsets;
  return normalized.map(clampRgbChannel).join(", ");
};

const readSvgTagAttrs = (source: string, tagName: string) => {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  return [...source.matchAll(pattern)].map((match) =>
    parseSvgAttrs(match[1] ?? ""),
  );
};

const readFilterReferenceId = (value: string | undefined) => {
  const match = value?.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i);
  return match?.[1];
};

const buildInnerShadowCssHint = ({
  color,
  dx,
  dy,
  opacity,
}: {
  color: string;
  dx: number;
  dy: number;
  opacity: number;
}) =>
  `box-shadow: inset ${formatCssLength(dx)} ${formatCssLength(
    dy,
  )} 0 rgba(${color}, ${formatCssNumber(opacity)})`;

const readInnerShadowEdges = ({ dx, dy }: { dx: number; dy: number }) => {
  const edges: Array<"bottom" | "left" | "right" | "top"> = [];
  if (dx > 0) edges.push("left");
  if (dx < 0) edges.push("right");
  if (dy > 0) edges.push("top");
  if (dy < 0) edges.push("bottom");
  return edges;
};

const extractSimpleFilterVisualEffects = ({
  body,
  filterId,
  scaleX,
  scaleY,
}: {
  body: string;
  filterId: string;
  scaleX: number;
  scaleY: number;
}): ModuleSemanticVisualEffect[] => {
  const offsetAttrs = readSvgTagAttrs(body, "feOffset")[0];
  if (!offsetAttrs) return [];

  const dx = readSvgNumber(offsetAttrs.dx) ?? 0;
  const dy = readSvgNumber(offsetAttrs.dy) ?? 0;
  const scaledDx = dx * scaleX;
  const scaledDy = dy * scaleY;
  if (
    (scaledDx === 0 && scaledDy === 0) ||
    Math.abs(scaledDx) > SIMPLE_FILTER_MAX_OFFSET ||
    Math.abs(scaledDy) > SIMPLE_FILTER_MAX_OFFSET
  ) {
    return [];
  }

  const hasInnerShadowComposite = readSvgTagAttrs(body, "feComposite").some(
    (attrs) =>
      attrs.operator === "arithmetic" &&
      readSvgNumber(attrs.k2) === -1 &&
      readSvgNumber(attrs.k3) === 1,
  );
  if (!hasInnerShadowComposite) return [];

  const hasLargeBlur = readSvgTagAttrs(body, "feGaussianBlur").some((attrs) =>
    readSvgNumberList(attrs.stdDeviation).some(
      (value) => Math.abs(value) > SIMPLE_FILTER_MAX_BLUR,
    ),
  );
  if (hasLargeBlur) return [];

  const colorMatrix = readSvgTagAttrs(body, "feColorMatrix")
    .map((attrs) => readSvgNumberList(attrs.values))
    .find((values) => {
      const alpha = values[18];
      return (
        values.length >= 20 &&
        typeof alpha === "number" &&
        alpha > 0 &&
        alpha <= SIMPLE_FILTER_MAX_OPACITY
      );
    });
  if (!colorMatrix) return [];

  const opacity = colorMatrix[18];
  if (typeof opacity !== "number") return [];

  const color = colorMatrixOffsetToRgb(colorMatrix);
  const edges = readInnerShadowEdges({ dx: scaledDx, dy: scaledDy });
  return [
    {
      color,
      cssHint: buildInnerShadowCssHint({
        color,
        dx: scaledDx,
        dy: scaledDy,
        opacity,
      }),
      dx: roundMetric(scaledDx),
      dy: roundMetric(scaledDy),
      ...(edges.length === 1 ? { edge: edges[0] } : {}),
      ...(edges.length ? { edges } : {}),
      opacity: roundMetric(opacity),
      source: "svg-filter",
      sourceFilterId: filterId,
      type: "inner-shadow",
    },
  ];
};

const extractSvgFilterVisualEffects = (
  svg: string,
  {
    scaleX,
    scaleY,
  }: {
    scaleX: number;
    scaleY: number;
  },
) => {
  const effectsByFilterId = new Map<string, ModuleSemanticVisualEffect[]>();
  for (const match of svg.matchAll(/<filter\b([^>]*)>([\s\S]*?)<\/filter>/gi)) {
    const attrs = parseSvgAttrs(match[1] ?? "");
    const filterId = attrs.id?.trim();
    if (!filterId) continue;
    const effects = extractSimpleFilterVisualEffects({
      body: match[2] ?? "",
      filterId,
      scaleX,
      scaleY,
    });
    if (effects.length) effectsByFilterId.set(filterId, effects);
  }
  return effectsByFilterId;
};

const readSvgViewBoxScale = ({
  height,
  viewBox,
  width,
}: {
  height: number | undefined;
  viewBox: string | undefined;
  width: number | undefined;
}) => {
  const [, , viewBoxWidth, viewBoxHeight] = readSvgNumberList(viewBox);
  return {
    scaleX:
      typeof width === "number" &&
      typeof viewBoxWidth === "number" &&
      viewBoxWidth > 0
        ? width / viewBoxWidth
        : 1,
    scaleY:
      typeof height === "number" &&
      typeof viewBoxHeight === "number" &&
      viewBoxHeight > 0
        ? height / viewBoxHeight
        : 1,
  };
};

const isVisibleVisualEffectTarget = (node: ModuleSemanticNode) => {
  if (!node.visible || !node.bbox) return false;
  if (!VISUAL_EFFECT_TARGET_TAGS.has(node.tag.toLowerCase())) return false;
  const fill = node.attrs.fill?.trim().toLowerCase();
  const stroke = node.attrs.stroke?.trim().toLowerCase();
  return fill !== "none" || Boolean(stroke && stroke !== "none");
};

const findCandidateVisualEffectTargetNodeIds = (
  node: ModuleSemanticNode,
  nodesById: Map<string, ModuleSemanticNode>,
) => {
  const nodeBox = readNumericBox(node.bbox);
  if (!nodeBox || node.childIds.length === 0) return [];
  return node.childIds
    .map((id) => nodesById.get(id))
    .filter((child): child is ModuleSemanticNode => Boolean(child))
    .filter((child) => {
      if (!isVisibleVisualEffectTarget(child)) return false;
      const childBox = readNumericBox(child.bbox);
      return (
        containmentRatioOrZero(nodeBox, childBox) >= 0.92 &&
        containmentRatioOrZero(childBox, nodeBox) >= 0.92
      );
    })
    .map((child) => child.id)
    .slice(0, 6);
};

const applySvgFilterVisualEffectHints = (
  nodes: ModuleSemanticNode[],
  effectsByFilterId: Map<string, ModuleSemanticVisualEffect[]>,
) => {
  if (effectsByFilterId.size === 0) {
    return {
      hintCount: 0,
      nodes: nodes.map((node) => {
        const visualEffects = node.visualEffects?.filter(
          (effect) => effect.source !== "svg-filter",
        );
        if (visualEffects?.length === node.visualEffects?.length) return node;
        const nextNode = { ...node };
        if (visualEffects?.length) nextNode.visualEffects = visualEffects;
        else delete nextNode.visualEffects;
        return nextNode;
      }),
    };
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const directEffectsByNodeId = new Map<string, ModuleSemanticVisualEffect[]>();
  const targetEffectsByNodeId = new Map<string, ModuleSemanticVisualEffect[]>();

  const appendEffects = (
    map: Map<string, ModuleSemanticVisualEffect[]>,
    nodeId: string,
    effects: ModuleSemanticVisualEffect[],
  ) => {
    const current = map.get(nodeId) ?? [];
    map.set(nodeId, [...current, ...effects]);
  };

  for (const node of nodes) {
    const filterId = readFilterReferenceId(node.attrs.filter);
    const filterEffects = filterId ? effectsByFilterId.get(filterId) ?? [] : [];
    if (filterEffects.length === 0) continue;

    const candidateTargetNodeIds = findCandidateVisualEffectTargetNodeIds(
      node,
      nodesById,
    );
    appendEffects(
      directEffectsByNodeId,
      node.id,
      filterEffects.map((effect) =>
        candidateTargetNodeIds.length
          ? { ...effect, candidateTargetNodeIds }
          : effect,
      ),
    );

    for (const targetNodeId of candidateTargetNodeIds) {
      appendEffects(
        targetEffectsByNodeId,
        targetNodeId,
        filterEffects.map((effect) => ({
          ...effect,
          candidateTargetNodeIds: [targetNodeId],
          sourceContainerNodeId: node.id,
        })),
      );
    }
  }

  let hintCount = 0;
  const nextNodes = nodes.map((node) => {
    const retainedEffects =
      node.visualEffects?.filter((effect) => effect.source !== "svg-filter") ??
      [];
    const nextFilterEffects = [
      ...(directEffectsByNodeId.get(node.id) ?? []),
      ...(targetEffectsByNodeId.get(node.id) ?? []),
    ];
    hintCount += nextFilterEffects.length;

    const visualEffects = [...retainedEffects, ...nextFilterEffects];
    if (
      visualEffects.length === 0 &&
      (!node.visualEffects || node.visualEffects.length === 0)
    ) {
      return node;
    }

    const nextNode = { ...node };
    if (visualEffects.length) nextNode.visualEffects = visualEffects;
    else delete nextNode.visualEffects;
    return nextNode;
  });

  return { hintCount, nodes: nextNodes };
};

const readSvgDomTextNodes = async ({
  fallbackHeight,
  fallbackWidth,
  moduleDir,
  moduleSvgPath,
  svg,
}: {
  fallbackHeight: number;
  fallbackWidth: number;
  moduleDir: string;
  moduleSvgPath: string;
  svg: string;
}): Promise<SvgDomTextNodeSummary[]> => {
  if (!/<(?:text|tspan)\b/i.test(svg)) return [];

  try {
    const design: ResolvedSvgDesign = {
      designName: `${path.basename(moduleDir)}-module-summary`,
      height: Math.max(1, Math.ceil(fallbackHeight)),
      scale: 1,
      svgPath: moduleSvgPath,
      width: Math.max(1, Math.ceil(fallbackWidth)),
    };
    const { result } = await readSvgLayout({
      design,
      wrapperName: "module-semantic-svg-layout.html",
      wrapperRoot: moduleDir,
    });

    return result.nodes
      .filter(
        (node) =>
          (node.tag === "text" || node.tag === "tspan") &&
          typeof node.textContent === "string" &&
          node.textContent.trim().length > 0,
      )
      .map((node) => ({
        attrs: pickSvgDomTextAttrs(node.attributes),
        nodePath: node.nodePath,
        pixelBox: node.pixelBox ?? undefined,
        tag: node.tag,
        text: node.textContent!.trim(),
        viewBoxBox: node.viewBoxBox ?? undefined,
      }))
      .slice(0, MAX_SVG_DOM_TEXT_NODE_COUNT);
  } catch {
    return [];
  }
};

const normalizeComparableText = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";

const buildTextGeometryDisagreements = ({
  textContentBlocks,
  textSummary,
}: {
  textContentBlocks: Array<{
    bbox?: Box;
    id: unknown;
    text: unknown;
  }>;
  textSummary: Array<{
    id: unknown;
    layoutTargetRegion?: Box;
    layoutTargetSource?: string;
    region?: Box;
    renderedTextRegion?: Box;
    sourceBlockText: unknown;
    text: unknown;
    textRegion?: Box;
  }>;
}) => {
  const contentById = new Map(
    textContentBlocks
      .filter((block) => typeof block.id === "string" && block.bbox)
      .map((block) => [block.id as string, block]),
  );
  const contentByText = new Map<string, (typeof textContentBlocks)[number]>();
  for (const block of textContentBlocks) {
    if (!block.bbox) continue;
    const text = normalizeComparableText(block.text);
    if (text && !contentByText.has(text)) contentByText.set(text, block);
  }

  return textSummary.flatMap((block) => {
    const id = typeof block.id === "string" ? block.id : "";
    const content =
      (id ? contentById.get(id) : undefined) ??
      contentByText.get(normalizeComparableText(block.sourceBlockText)) ??
      contentByText.get(normalizeComparableText(block.text));
    const textBox =
      block.layoutTargetRegion ??
      block.renderedTextRegion ??
      block.textRegion ??
      block.region;
    if (!content?.bbox || !textBox) return [];

    const contentCenter = centerOf(content.bbox);
    const textCenter = centerOf(textBox);
    const deltaX = Number((textBox.x - content.bbox.x).toFixed(3));
    const deltaY = Number((textBox.y - content.bbox.y).toFixed(3));
    const centerDeltaX = Number((textCenter.x - contentCenter.x).toFixed(3));
    const centerDeltaY = Number((textCenter.y - contentCenter.y).toFixed(3));
    const widthDelta = Number((textBox.width - content.bbox.width).toFixed(3));
    const heightDelta = Number((textBox.height - content.bbox.height).toFixed(3));
    const maxHorizontalDelta = Math.max(
      Math.abs(deltaX),
      Math.abs(centerDeltaX),
    );
    const maxVerticalDelta = Math.max(Math.abs(deltaY), Math.abs(centerDeltaY));
    const widthRatio =
      Math.max(textBox.width, content.bbox.width) /
      Math.max(1, Math.min(textBox.width, content.bbox.width));
    const heightRatio =
      Math.max(textBox.height, content.bbox.height) /
      Math.max(1, Math.min(textBox.height, content.bbox.height));

    if (
      maxHorizontalDelta < TEXT_GEOMETRY_IGNORE_MAX_HORIZONTAL_DELTA &&
      maxVerticalDelta < TEXT_GEOMETRY_IGNORE_MAX_VERTICAL_DELTA &&
      widthRatio < TEXT_GEOMETRY_IGNORE_MAX_WIDTH_RATIO &&
      heightRatio < TEXT_GEOMETRY_IGNORE_MAX_HEIGHT_RATIO
    ) {
      return [];
    }

    return [
      {
        centerDeltaX,
        centerDeltaY,
        deltaX,
        deltaY,
        heightDelta,
        id: block.id,
        layoutTargetSource: block.layoutTargetSource,
        contentBox: content.bbox,
        contentText: content.text,
        text: block.text,
        textCandidateBox: textBox,
        widthDelta,
      },
    ];
  });
};

const compactBoxList = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const box = compactBox(item);
        return box ? [box] : [];
      })
    : [];

const countExplicitTextLines = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const count = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
    if (count > 1) return count;
  }
  return undefined;
};

const compactTextLines = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isRecord(item)) return [];
        const region = compactBox(item.region);
        if (!region) return [];
        return [
          {
            region,
            text: typeof item.text === "string" ? item.text : undefined,
          },
        ];
      })
    : [];

const writeModuleSemanticPayload = async ({
  allowedAssets,
  basePayload,
  elementAnalysis,
  module,
  moduleDir,
  textHints,
  moduleTextBlocks,
  scale,
  moduleTextStyleHints,
  moduleSvgPath,
}: WriteModuleSemanticPayloadInput) => {
  const moduleContextSvgPath = path.join(moduleDir, "module-context.svg");
  const [
    svg,
    svgStat,
    contextSvgStat,
    assets,
    textHintBlocks,
    textBlocks,
    textStyleHints,
  ] = await Promise.all([
    readFile(moduleSvgPath, "utf8"),
    stat(moduleSvgPath),
    statOptional(moduleContextSvgPath),
    Promise.resolve(
      Array.isArray(allowedAssets)
        ? allowedAssets.filter(isRecord)
        : [],
    ),
    Promise.resolve(
      Array.isArray(textHints)
        ? textHints.filter(isRecord)
        : isRecord(textHints) && Array.isArray(textHints.blocks)
          ? textHints.blocks.filter(isRecord)
          : [],
    ),
    Promise.resolve(
      Array.isArray(moduleTextBlocks)
        ? moduleTextBlocks.filter(isRecord)
        : isRecord(moduleTextBlocks) && Array.isArray(moduleTextBlocks.blocks)
          ? moduleTextBlocks.blocks.filter(isRecord)
          : [],
    ),
    Promise.resolve(
      Array.isArray(moduleTextStyleHints)
        ? moduleTextStyleHints.filter(isRecord)
        : isRecord(moduleTextStyleHints) && Array.isArray(moduleTextStyleHints.blocks)
          ? moduleTextStyleHints.blocks.filter(isRecord)
          : [],
    ),
  ]);
  const inspection: SvgInspection = {
    bytes: svgStat.size,
    ...inspectSvgSource({ svg }),
  };
  const svgCoordinateScale = readSvgViewBoxScale({
    height: inspection.height,
    viewBox: inspection.viewBox,
    width: inspection.width,
  });
  const svgFilterVisualEffects = extractSvgFilterVisualEffects(
    svg,
    svgCoordinateScale,
  );
  const svgDomTextNodes = await readSvgDomTextNodes({
    fallbackHeight: inspection.height ?? module.region.height,
    fallbackWidth: inspection.width ?? module.region.width,
    moduleDir,
    moduleSvgPath,
    svg,
  });
  const assetSummary = assets.map((asset) => ({
    assetName: asset.assetName ?? asset.name,
    assetRole: asset.assetRole,
    kind: asset.assetKind ?? asset.kind,
    moduleBox: compactBox(asset.moduleBox),
    overlapsReadableText: asset.overlapsReadableText,
    priority: asset.priority,
    relativePath: asset.relativePath ?? asset.htmlRef,
    risk: asset.risk,
    riskReasons: asset.riskReasons,
    textTreatment: asset.textTreatment,
  }));
  const textContentBlocks = textHintBlocks.map((block) => ({
    bbox: readNumericBox(block.bbox),
    confidence: block.confidence,
    id: block.id,
    role: block.role,
    text: block.text,
  }));
  const textStyleSummary = textStyleHints.map((hint) => {
    const declarations = isRecord(hint.declarations)
      ? (hint.declarations as Record<string, unknown>)
      : {};
    const fit = isRecord(hint.fit) ? hint.fit : {};
    const resolvedLineCount =
      typeof hint.lineCount === "number" && Number.isFinite(hint.lineCount)
        ? Math.round(hint.lineCount)
        : countExplicitTextLines(hint.text);
    const isSingleLine = !resolvedLineCount || resolvedLineCount <= 1;
    return {
      declarations: {
        color: declarations.color,
        "font-family": declarations["font-family"],
        "font-size": declarations["font-size"],
        "font-weight": declarations["font-weight"],
        "letter-spacing": declarations["letter-spacing"],
        "line-height": declarations["line-height"],
        "white-space": declarations["white-space"],
        // Single-line text: force nowrap to prevent unexpected wrapping due to
        // font metric differences between SVG path rendering and browser text.
        ...(isSingleLine && !declarations["white-space"]
          ? { "white-space": "nowrap" }
          : {}),
      },
      fitScore: fit.score,
      id: hint.id,
      kind: hint.kind,
      lineCount: resolvedLineCount,
      region: compactBox(hint.region),
      text: hint.text,
    };
  });
  const textStyleSummaryById = new Map(
    textStyleSummary
      .filter((hint) => typeof hint.id === "string" && hint.id.length > 0)
      .map((hint) => [hint.id, hint]),
  );
  const textSummary = textBlocks.map((block) => {
    const lineRegions = compactBoxList(block.lineRegions);
    const lines = compactTextLines(block.lines);
    return {
      bboxIncludesIcon: block.bboxIncludesIcon,
      confidence: block.confidence,
      color: typeof block.color === "string" ? block.color : undefined,
      id: block.id,
      kind: block.kind,
      layoutTargetRegion: pickLayoutTargetRegion({
        region: readNumericBox(block.region),
        renderedTextRegion: readNumericBox(block.renderedTextRegion),
        textRegion: readNumericBox(block.textRegion),
      }),
      layoutTargetSource: pickLayoutTargetSource({
        region: readNumericBox(block.region),
        renderedTextRegion: readNumericBox(block.renderedTextRegion),
        textRegion: readNumericBox(block.textRegion),
      }),
      lineCount:
        typeof block.lineCount === "number" && Number.isFinite(block.lineCount)
          ? Math.round(block.lineCount)
          : countExplicitTextLines(block.text, block.sourceBlockText),
      ...(lineRegions.length > 0 ? { lineRegions } : {}),
      ...(lines.length > 0 ? { lines } : {}),
      region: readNumericBox(block.region),
      renderedTextRegion: readNumericBox(block.renderedTextRegion),
      source: block.source,
      sourceBlockId:
        typeof block.sourceBlockId === "string"
          ? block.sourceBlockId
          : undefined,
      sourceBlockText: block.sourceBlockText,
      styleInference:
        typeof block.id === "string"
          ? textStyleSummaryById.get(block.id)?.declarations
          : undefined,
      text: block.text,
      textRegion: readNumericBox(block.textRegion),
    };
  });
  const textGeometryDisagreements = buildTextGeometryDisagreements({
    textContentBlocks,
    textSummary,
  });
  const contentById = new Map(
    textContentBlocks
      .filter((block) => typeof block.id === "string" && block.id.length > 0)
      .map((block) => [block.id as string, block]),
  );
  const textLikeSvgElements = (elementAnalysis?.elements ?? [])
    .flatMap((element) => {
      const elementBox = bboxArrayToBox(element.bbox);
      const primaryText =
        typeof element.semanticText === "string" && element.semanticText.trim().length > 0
          ? element.semanticText.trim()
          : Array.isArray(element.matchedTextBlocks) &&
              element.matchedTextBlocks.some(
                (value) => typeof value === "string" && value.trim().length > 0,
              )
            ? String(
                element.matchedTextBlocks.find(
                  (value) =>
                    typeof value === "string" && value.trim().length > 0,
                ),
              ).trim()
            : undefined;
      const relevant =
        element.classification === "plain-text" ||
        element.classification === "atomic-visual-text" ||
        element.containsText === true ||
        Boolean(primaryText);
      if (!relevant) return [];

      const matchedTextBlocks = textSummary.filter((block) => {
        const blockBox =
          block.layoutTargetRegion ?? block.textRegion ?? block.region;
        const idMatches =
          (typeof block.sourceBlockId === "string" &&
            Array.isArray(element.matchedTextBlockIds) &&
            element.matchedTextBlockIds.includes(block.sourceBlockId)) ||
          (typeof block.id === "string" &&
            Array.isArray(element.matchedTextBlockIds) &&
            element.matchedTextBlockIds.includes(block.id));
        const textMatches =
          normalizeComparableText(block.text) !== "" &&
          normalizeComparableText(block.text) ===
            normalizeComparableText(primaryText ?? "");
        const geometryMatches = overlapRatioOrZero(elementBox, blockBox) >= 0.28;
        return idMatches || (textMatches && geometryMatches);
      });

      const matchedSvgDomTextNodes = svgDomTextNodes.filter((node) => {
        const textMatches =
          normalizeComparableText(node.text) !== "" &&
          normalizeComparableText(node.text) ===
            normalizeComparableText(primaryText ?? "");
        const geometryMatches =
          overlapRatioOrZero(elementBox, node.pixelBox) >= 0.28 ||
          overlapRatioOrZero(elementBox, node.viewBoxBox) >= 0.28;
        return textMatches || (geometryMatches && textMatches);
      });

      return [
        {
          bbox: elementBox,
          classification: element.classification,
          exportDecision:
            typeof element.exportDecision === "string"
              ? element.exportDecision
              : undefined,
          index: element.index,
          nodeId:
            typeof element.nodeId === "string" && element.nodeId.length > 0
              ? element.nodeId
              : undefined,
          nodePath:
            typeof element.nodePath === "string" && element.nodePath.length > 0
              ? element.nodePath
              : undefined,
          matchedSvgDomTextNodePaths: matchedSvgDomTextNodes.map(
            (node) => node.nodePath,
          ),
          matchedTextBlockIds: matchedTextBlocks
            .map((block) => (typeof block.id === "string" ? block.id : undefined))
            .filter((value): value is string => typeof value === "string"),
          primaryText,
          visionReason:
            typeof element.visionReason === "string"
              ? element.visionReason
              : undefined,
        },
      ];
    })
    .sort((left, right) => left.index - right.index);
  const mergedTextResources = textSummary.map((block) => {
    const blockBox =
      block.layoutTargetRegion ?? block.textRegion ?? block.region;
    const sourceBlockId =
      typeof block.sourceBlockId === "string" ? block.sourceBlockId : undefined;
    const matchedContent =
      (sourceBlockId ? contentById.get(sourceBlockId) : undefined) ??
      (typeof block.id === "string" ? contentById.get(block.id) : undefined) ??
      textContentBlocks.find(
        (content) =>
          normalizeComparableText(String(content.text ?? "")) !== "" &&
          normalizeComparableText(String(content.text ?? "")) ===
            normalizeComparableText(block.sourceBlockText ?? block.text ?? ""),
      );
    const matchedSvgElements = textLikeSvgElements.filter((element) => {
      const idMatches =
        (sourceBlockId !== undefined &&
          element.matchedTextBlockIds.includes(sourceBlockId)) ||
        (typeof block.id === "string" &&
          element.matchedTextBlockIds.includes(block.id));
      const textMatches =
        normalizeComparableText(block.text) !== "" &&
        (normalizeComparableText(block.text) ===
          normalizeComparableText(element.primaryText ?? "") ||
          normalizeComparableText(block.sourceBlockText ?? "") ===
            normalizeComparableText(element.primaryText ?? ""));
      const geometryMatches = overlapRatioOrZero(blockBox, element.bbox) >= 0.28;
      return idMatches || (textMatches && geometryMatches);
    });
    const hasAtomicVisualTextAsset = matchedSvgElements.some(
      (element) =>
        element.classification === "atomic-visual-text" &&
        element.exportDecision === "export",
    );

    return {
      id: block.id,
      layoutTargetRegion: block.layoutTargetRegion,
      matchedContentBox: matchedContent?.bbox,
      matchedContentId:
        typeof matchedContent?.id === "string" ? matchedContent.id : undefined,
      matchedSvgElementNodeIds: matchedSvgElements
        .map((element) => element.nodeId)
        .filter((value): value is string => typeof value === "string"),
      matchedSvgElementNodePaths: matchedSvgElements
        .map((element) => element.nodePath)
        .filter((value): value is string => typeof value === "string"),
      recommendedHandling: hasAtomicVisualTextAsset
        ? "single-node-visual-text-asset"
        : "dom-text",
      sourceBlockId,
      sourceBlockText: block.sourceBlockText,
      text: block.text,
    };
  });
  const textResourceById = new Map(
    mergedTextResources
      .filter((block) => typeof block.id === "string" && block.id.length > 0)
      .map((block) => [block.id, block]),
  );
  const semanticTextBlocks = textSummary.map((block) => {
    const textRegion =
      block.textRegion ?? block.layoutTargetRegion ?? block.region;
    const textResource =
      typeof block.id === "string" ? textResourceById.get(block.id) : undefined;
    return {
      ...block,
      sourceNodeIds: textResource?.matchedSvgElementNodeIds ?? [],
      sourceNodePaths: textResource?.matchedSvgElementNodePaths ?? [],
      styleInference:
        typeof block.id === "string"
          ? textStyleSummaryById.get(block.id)?.declarations
          : undefined,
      textRegion,
    };
  });
  const semanticGeneratedAssets = assets.flatMap((asset, index) => {
    const assetPath =
      (typeof asset.path === "string" && asset.path) ||
      (typeof asset.relativePath === "string" && asset.relativePath) ||
      (typeof asset.htmlRef === "string" && asset.htmlRef);
    if (!assetPath) return [];
    const sourceNodeIds = Array.isArray(asset.sourceNodeIds)
      ? asset.sourceNodeIds.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : [];
    const sourceNodePaths = Array.isArray(asset.sourceNodePaths)
      ? asset.sourceNodePaths.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : [];
    return [
      {
        ...asset,
        assetRole:
          typeof asset.assetRole === "string" && asset.assetRole.length > 0
            ? asset.assetRole
            : "visual-asset",
        box: compactBox(asset.box ?? asset.moduleBox),
        id:
          (typeof asset.id === "string" && asset.id) ||
          (typeof asset.assetId === "string" && asset.assetId) ||
          `${module.id}:generated-asset-${String(index + 1).padStart(3, "0")}`,
        htmlRef:
          typeof asset.htmlRef === "string" ? asset.htmlRef : assetPath,
        path: assetPath,
        readableByAgent: asset.readableByAgent === true,
        relativePath:
          typeof asset.relativePath === "string" ? asset.relativePath : assetPath,
        source:
          typeof asset.source === "string"
            ? asset.source
            : "module-agent.export-svg-node-asset",
        sourceNodeIds,
        sourceNodePaths,
        textTreatment:
          typeof asset.textTreatment === "string" && asset.textTreatment.length > 0
            ? asset.textTreatment
            : "unknown",
      },
    ];
  });
  const summaryStats = {
    agentGeneratedAssetCount: semanticGeneratedAssets.length,
    exportableSvgNodeCount:
      elementAnalysis?.elements.filter(
        (element) => element.exportDecision === "export",
      ).length ?? 0,
    textContentBlockCount: textContentBlocks.length,
    graphicAssetCount: assetSummary.length,
    svgTextNodeCount: svgDomTextNodes.length,
    textBlockCount: textSummary.length,
    textAppearanceHintCount: textStyleSummary.length,
    textGeometryDisagreementCount: textGeometryDisagreements.length,
    visualTextElementCount: textLikeSvgElements.length,
  };
  const inputContract = {
    allowHostArtifactFallback: false,
    focusOrder: [
      "guidance",
      "module",
      "textResources",
      "textBlocks",
      "textAppearanceHints",
      "generatedAssets",
      "graphicAssets",
      "nodes",
      "svgSummary",
    ],
    instruction: INPUT_CONTRACT_INSTRUCTION,
    primaryStructuredInput: "module-semantic.json",
  };
  const payload = {
    summaryVersion: MODULE_SEMANTIC_PAYLOAD_VERSION,
    inputContract,
    summaryStats,
    graphicAssets: assetSummary,
    guidance: {
      exportSvgNodeCommand: `${EXPORT_SVG_NODE_COMMAND_TEMPLATE} ${scale}`,
      readPolicy: SEMANTIC_READ_POLICY,
      layoutTargetRule: LAYOUT_TARGET_RULE,
    },
    module: {
      id: module.id,
      kind: module.kind,
      region: module.region,
      scale,
    },
    generatedAssets: semanticGeneratedAssets,
    textResources: mergedTextResources,
    textBlocks: semanticTextBlocks,
    textGeometryDisagreements,
    visualTextElements: textLikeSvgElements,
    textAppearanceHints: textStyleSummary,
    svgSummary: {
      contextBytes: contextSvgStat?.size,
      hasContextSvg: Boolean(contextSvgStat),
      ...inspection,
    },
    textContentBlocks,
    svgTextNodes: svgDomTextNodes,
    ...(elementAnalysis
      ? {
          svgNodeAssets: {
            elements: elementAnalysis.elements.map((element) => ({
              bbox: element.bbox,
              classification: element.classification,
              containsText: element.containsText,
              dLength: element.dLength,
              exportDecision: element.exportDecision,
              fill: element.fill,
              hasImage: element.hasImage,
              index: element.index,
              matchedTextBlockIds: element.matchedTextBlockIds,
              matchedTextBlocks: element.matchedTextBlocks,
              nodeId: element.nodeId,
              nodePath: element.nodePath,
              semanticText: element.semanticText,
              tag: element.tag,
            })),
            skipIndices: elementAnalysis.skipIndices,
          },
        }
      : {}),
  };
  const jsonPath = path.join(moduleDir, "module-semantic.json");
  const currentPayload = basePayload ?? (await readJsonRecordIfValid(jsonPath));
  const completedStages = new Set<string>(
    isRecord(currentPayload.runtime) &&
      Array.isArray(currentPayload.runtime.completedStages)
      ? currentPayload.runtime.completedStages.filter(
          (stage): stage is string =>
            typeof stage === "string" && stage.length > 0,
        )
      : [],
  );
  completedStages.add("input-summary");
  if (semanticTextBlocks.length) completedStages.add("text-blocks");
  if (textStyleSummary.length) completedStages.add("text-style-inference");
  let nextPayload: Record<string, unknown> = {
    ...currentPayload,
    ...payload,
    runtime: {
      ...(isRecord(currentPayload.runtime)
        ? currentPayload.runtime
        : {}),
      completedStages: [...completedStages].sort((left, right) =>
        left.localeCompare(right),
      ),
    },
  };
  if (Array.isArray(nextPayload.nodes)) {
    const visualEffectHints = applySvgFilterVisualEffectHints(
      nextPayload.nodes as ModuleSemanticNode[],
      svgFilterVisualEffects,
    );
    nextPayload = {
      ...nextPayload,
      nodes: visualEffectHints.nodes,
      summaryStats: {
        ...(isRecord(nextPayload.summaryStats)
          ? nextPayload.summaryStats
          : {}),
        visualEffectHintCount: visualEffectHints.hintCount,
      },
    };
    // Preserve the full payload (including diagnostic-only arrays) for human
    // troubleshooting, then hand the agent a slimmed document.
    await writeJsonFile(
      path.join(moduleDir, "module-semantic.debug.json"),
      nextPayload,
    );
    nextPayload = compactDocumentForAgent(
      nextPayload as { nodes: ModuleSemanticNode[] },
    ) as Record<string, unknown>;
  }
  await writeJsonFile(jsonPath, nextPayload);

  return {
    jsonPath,
  };
};

export { writeModuleSemanticPayload };
