import { areaOf, intersectionArea } from "../../../core/geometry.js";
import type {
  ModuleSemanticNode,
  ModuleSemanticNodeSemantic,
} from "./module-semantic.js";

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
    if (node.tag !== "g") continue;
    if (!node.childIds || node.childIds.length < 2) continue;

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

    const effectCandidates = pathChildren.filter((candidate) =>
      Boolean(candidate.attrs.mask),
    );
    if (effectCandidates.length === 0) continue;

    const fillCandidates = pathChildren.filter((candidate) => !candidate.attrs.mask);
    if (fillCandidates.length === 0) continue;

    const effectNodeIds: string[] = [];
    let fillNodeId: string | undefined;
    let effectType = "masked-layer";

    for (const effect of effectCandidates) {
      if (!effect.bbox) continue;
      const effectPdl = Number(effect.attrs.pathDataLength ?? 0);

      const matchingFill = fillCandidates.find((fill) => {
        if (!fill.bbox) return false;
        const smaller = Math.min(areaOf(fill.bbox), areaOf(effect.bbox!));
        if (smaller <= 0) return false;
        const overlap = intersectionArea(fill.bbox, effect.bbox!) / smaller;
        if (overlap < 0.6) return false;

        const fillPdl = Number(fill.attrs.pathDataLength ?? 0);
        if (fillPdl <= 0 || effectPdl <= 0) return false;
        const pdlRatio = effectPdl / fillPdl;
        return pdlRatio >= 3;
      });

      if (matchingFill) {
        effectNodeIds.push(effect.id);
        fillNodeId = matchingFill.id;

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
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  let count = 0;

  for (const group of groups) {
    const parentNode = nodesById.get(group.parentId);

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

    deterministicById.set(group.fillNodeId, {
      containsReadableText: true,
      exportDecision: "skip",
      kind: "visual-text",
      notes: `text fill layer of ${group.parentId}; export parent text effect group to preserve ${group.effectType}`,
      textHandling: "ignore",
    });
    count += 1;

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

export {
  applyTextEffectLayerSemantics,
  detectTextEffectLayerGroups,
};
export type { TextEffectLayerGroup };
