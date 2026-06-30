import {
  readString,
  type ModuleSemanticNode,
  type ModuleSemanticNodeSemantic,
} from "./module-semantic.js";
import { isPureTransparentNode } from "./module-semantic-paint.js";

const CONTAINER_VISUAL_TAGS = new Set(["a", "g", "svg", "switch", "symbol"]);
const VISUAL_CONTEXT_REFERENCE_ATTRS = [
  "clip-path",
  "filter",
  "mask",
] as const;

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

const DEFINITE_NON_TEXT_TAGS = new Set([
  "circle",
  "ellipse",
  "image",
  "line",
  "rect",
]);

const hasVisualContextReference = (node: ModuleSemanticNode) =>
  VISUAL_CONTEXT_REFERENCE_ATTRS.some((attr) => {
    const value = node.attrs[attr];
    return typeof value === "string" && /^url\(/i.test(value.trim());
  });

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
    if (hasVisualContextReference(node)) {
      return {
        confidence: 1,
        containsReadableText: false,
        exportDecision: "export",
        kind: "visual-context-wrapper",
        notes: "container has mask/clip/filter context that affects descendant rendering; export wrapper to preserve visual context",
        textHandling: "ignore",
      };
    }
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

export { buildDeterministicSemantic };
