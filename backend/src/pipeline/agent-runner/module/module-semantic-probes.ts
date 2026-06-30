import type { Box } from "../../../core/geometry.js";
import type { ModuleSemanticNode } from "./module-semantic.js";

type SemanticProbeNode = ModuleSemanticNode & {
  bbox: Box;
  selector: string;
};

const SHAPE_TAGS = new Set([
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
]);

const toProbeNode = (node: ModuleSemanticNode): SemanticProbeNode | null =>
  node.bbox && node.selector && node.childIds.length === 0
    ? {
        ...node,
        bbox: node.bbox,
        selector: node.selector,
      }
    : null;

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

const computeProbeFingerprint = (node: SemanticProbeNode): string => {
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

const deduplicateProbeNodes = (
  nodes: SemanticProbeNode[],
): {
  deduplicated: SemanticProbeNode[];
  duplicateToRepresentative: Map<string, string>;
} => {
  if (nodes.length <= 1) {
    return { deduplicated: nodes, duplicateToRepresentative: new Map() };
  }

  const fingerprintGroups = new Map<string, SemanticProbeNode[]>();
  for (const node of nodes) {
    const fingerprint = computeProbeFingerprint(node);
    const group = fingerprintGroups.get(fingerprint);
    if (group) {
      group.push(node);
    } else {
      fingerprintGroups.set(fingerprint, [node]);
    }
  }

  const deduplicated: SemanticProbeNode[] = [];
  const duplicateToRepresentative = new Map<string, string>();

  for (const [, group] of fingerprintGroups) {
    if (group.length === 0) continue;
    const representative = group[0]!;
    deduplicated.push(representative);

    for (let index = 1; index < group.length; index += 1) {
      duplicateToRepresentative.set(group[index]!.id, representative.id);
    }
  }

  return { deduplicated, duplicateToRepresentative };
};

export {
  computeProbeFingerprint,
  deduplicateProbeNodes,
  hasIntrinsicVisualPresence,
  toProbeNode,
};
export type { SemanticProbeNode };
