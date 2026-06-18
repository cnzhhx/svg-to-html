import {
  areaOf,
  bottomOf,
  centerOf,
  clamp,
  intersectionArea,
  isPageScaleBox,
  overlapLength,
  pointInside,
  rightOf,
  round,
  unionBoxes,
  uniqueStrings,
} from "../geometry.js";
import type { SvgLayoutNode } from "../svg-layout.js";
import type { Box, Region } from '../geometry.js';
import {
  expandRegion,
  toModuleBox,
  toSerializableRegion,
} from "../svg-vertical-modules/geometry.js";
import type {
  PlannedModules,
  SvgSharedLayer,
  SvgVerticalModule,
} from "../svg-vertical-modules/types.js";
import type {
  ModelPlannerModule,
  NormalizeModelPlanInput,
  ValidationSourceBox,
} from "./types.js";
import {
  collectValidationSourceBoxes,
  isLargeBackgroundLikeBox,
  normalizeModuleKind,
  repairRegionsAwayFromSourceBoxes,
} from "./validate-plan.js";

const SNAP_TOLERANCE_PX = 24;
const REGION_STITCH_TOLERANCE_PX = 2;

const isRenderableContentNode = (node: SvgLayoutNode) =>
  node.depth > 0 &&
  !["a", "defs", "g", "svg", "switch"].includes(node.tag) &&
  !node.nodePath.includes("> defs:nth-of-type");

type NodeMatch = { box: Box; node: SvgLayoutNode; order: number };

const intersectsRegion = (box: Box, region: Region) => {
  const boxArea = Math.max(1, areaOf(box));
  return (
    pointInside(centerOf(box), region) ||
    intersectionArea(box, region) / boxArea >= 0.2
  );
};

const nodeBox = (node: SvgLayoutNode, viewport: Box) => {
  const box = node.visibleBox ?? node.pixelBox;
  if (!box) return null;
  return toModuleBox(box, viewport);
};

const sourceContainerIdsForRegion = ({
  containerLayout,
  region,
  viewport,
}: Pick<NormalizeModelPlanInput, "containerLayout"> & {
  region: Region;
  viewport: Box;
}) =>
  uniqueStrings(
    (containerLayout?.containers ?? [])
      .filter(
        (container) =>
          intersectsRegion(container.box, region) &&
          !isPageScaleBox(container.box, viewport.width, viewport.height),
      )
      .map((container) => container.id),
  );

const collectSafeYLines = ({
  sourceBoxes,
  viewport,
}: {
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  const boxes = sourceBoxes
    .filter((sourceBox) => sourceBox.kind !== "repeat-group")
    .map((sourceBox) => sourceBox.box)
    .filter((box) => box.height > 0 && box.width > 0)
    .sort((left, right) => left.y - right.y);
  const bands: Box[] = [];

  boxes.forEach((box) => {
    const current = bands.at(-1);
    if (!current || box.y - bottomOf(current) > 4) {
      bands.push({ ...box });
      return;
    }
    const right = Math.max(rightOf(current), rightOf(box));
    const bottom = Math.max(bottomOf(current), bottomOf(box));
    current.x = Math.min(current.x, box.x);
    current.y = Math.min(current.y, box.y);
    current.width = right - current.x;
    current.height = bottom - current.y;
  });

  const lines = [viewport.y, bottomOf(viewport)];
  bands.forEach((band, index) => {
    const next = bands[index + 1];
    if (!next) return;
    const gap = next.y - bottomOf(band);
    if (gap >= 8) lines.push(round(bottomOf(band) + gap / 2));
  });
  return [...new Set(lines)].sort((left, right) => left - right);
};

const snapY = (value: number, safeYLines: number[], viewport: Box) => {
  if (
    Math.abs(value - viewport.y) <= SNAP_TOLERANCE_PX ||
    Math.abs(value - bottomOf(viewport)) <= SNAP_TOLERANCE_PX
  ) {
    return clamp(value, viewport.y, bottomOf(viewport));
  }

  const nearest = safeYLines
    .map((line) => ({ distance: Math.abs(line - value), line }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (!nearest || nearest.distance > SNAP_TOLERANCE_PX) return value;
  return nearest.line;
};

const normalizeRegion = ({
  index,
  module,
  safeYLines,
  viewport,
}: {
  index: number;
  module: ModelPlannerModule;
  safeYLines: number[];
  viewport: Box;
}) => {
  const raw = module.region!;
  const x1 = clamp(raw.x, viewport.x, rightOf(viewport));
  const y1 = snapY(clamp(raw.y, viewport.y, bottomOf(viewport)), safeYLines, viewport);
  const x2 = clamp(raw.x + raw.width, viewport.x, rightOf(viewport));
  const y2 = snapY(
    clamp(raw.y + raw.height, viewport.y, bottomOf(viewport)),
    safeYLines,
    viewport,
  );
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);

  return {
    id: `module-${String(index + 1).padStart(2, "0")}`,
    kind: normalizeModuleKind(module.kind),
    reason:
      typeof module.reason === "string" && module.reason.trim()
        ? module.reason.trim()
        : "Model-planned semantic visual module.",
    region: {
      height,
      width,
      x: x1,
      y: y1,
    },
  };
};

type NormalizedModuleRegion = ReturnType<typeof normalizeRegion>;

const cloneNormalizedModuleRegion = (
  module: NormalizedModuleRegion,
): NormalizedModuleRegion => ({
  ...module,
  region: { ...module.region },
});

const hasCoveringFallbackRegion = ({
  modules,
  viewport,
}: {
  modules: NormalizedModuleRegion[];
  viewport: Box;
}) => {
  const viewportArea = Math.max(1, areaOf(viewport));
  return modules.some((module) => {
    const coverage = intersectionArea(module.region, viewport) / viewportArea;
    return (
      coverage >= 0.82 ||
      (module.region.width >= viewport.width * 0.9 &&
        module.region.height >= viewport.height * 0.75)
    );
  });
};

const isFlatVerticalStack = (modules: NormalizedModuleRegion[]) => {
  if (modules.length <= 1) return false;

  for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
    const left = modules[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < modules.length;
      rightIndex += 1
    ) {
      const right = modules[rightIndex]!;
      const verticalOverlap = overlapLength(
        left.region.y,
        bottomOf(left.region),
        right.region.y,
        bottomOf(right.region),
      );
      const smallerHeight = Math.max(
        1,
        Math.min(left.region.height, right.region.height),
      );
      if (verticalOverlap / smallerHeight > 0.25) return false;
    }
  }

  return true;
};

const stitchFlatVerticalRegions = ({
  modules,
  viewport,
}: {
  modules: NormalizedModuleRegion[];
  viewport: Box;
}) => {
  const viewportBottom = bottomOf(viewport);
  const sorted = modules
    .map(cloneNormalizedModuleRegion)
    .sort(
      (left, right) =>
        left.region.y - right.region.y || left.region.x - right.region.x,
    );

  let top = viewport.y;
  return sorted.map((module, index) => {
    const next = sorted[index + 1];
    const bottom = next
      ? clamp(next.region.y, top + 1, viewportBottom)
      : viewportBottom;
    const stitched = {
      ...module,
      region: {
        height: Math.max(1, bottom - top),
        width: viewport.width,
        x: viewport.x,
        y: top,
      },
    };
    top = bottom;
    return stitched;
  });
};

const collectBoundarySourceBands = ({
  sourceBoxes,
  viewport,
}: {
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  const boxes = sourceBoxes
    .filter(
      (sourceBox) =>
        sourceBox.kind !== "repeat-group" &&
        !isLargeBackgroundLikeBox(sourceBox.box, viewport),
    )
    .map((sourceBox) => sourceBox.box)
    .filter((box) => box.width > 0 && box.height > 0)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const bands: Box[] = [];

  boxes.forEach((box) => {
    const current = bands.at(-1);
    if (!current || box.y - bottomOf(current) > 4) {
      bands.push({ ...box });
      return;
    }
    const right = Math.max(rightOf(current), rightOf(box));
    const bottom = Math.max(bottomOf(current), bottomOf(box));
    current.x = Math.min(current.x, box.x);
    current.y = Math.min(current.y, box.y);
    current.width = right - current.x;
    current.height = bottom - current.y;
  });

  return bands;
};

const setBoundaryY = ({
  boundaryIndex,
  modules,
  y,
}: {
  boundaryIndex: number;
  modules: NormalizedModuleRegion[];
  y: number;
}) => {
  const previous = modules[boundaryIndex - 1];
  const current = modules[boundaryIndex];
  if (!previous || !current) return;

  const previousTop = previous.region.y;
  const currentBottom = bottomOf(current.region);
  const nextY = clamp(y, previousTop + 1, currentBottom - 1);

  previous.region.height = Math.max(1, nextY - previousTop);
  current.region.y = nextY;
  current.region.height = Math.max(1, currentBottom - nextY);
};

const avoidCuttingSourceBands = ({
  modules,
  sourceBoxes,
  viewport,
}: {
  modules: NormalizedModuleRegion[];
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  const bands = collectBoundarySourceBands({ sourceBoxes, viewport });
  if (!bands.length) return modules;

  const repaired = modules.map(cloneNormalizedModuleRegion);
  for (let index = 1; index < repaired.length; index += 1) {
    const previous = repaired[index - 1]!;
    const current = repaired[index]!;
    const boundary = current.region.y;
    const crossingBands = bands.filter(
      (band) =>
        boundary > band.y + REGION_STITCH_TOLERANCE_PX &&
        boundary < bottomOf(band) - REGION_STITCH_TOLERANCE_PX,
    );
    if (!crossingBands.length) continue;

    const assignToCurrent =
      previous.kind === "global-shell" && current.kind !== "global-shell";
    const desiredBoundary = assignToCurrent
      ? Math.min(...crossingBands.map((band) => band.y))
      : Math.max(...crossingBands.map((band) => bottomOf(band)));

    setBoundaryY({
      boundaryIndex: index,
      modules: repaired,
      y: round(desiredBoundary),
    });
  }

  return repaired;
};

const normalizeTopLevelCoverage = ({
  modules,
  sourceBoxes,
  viewport,
}: {
  modules: NormalizedModuleRegion[];
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  if (
    hasCoveringFallbackRegion({ modules, viewport }) ||
    !isFlatVerticalStack(modules)
  ) {
    return {
      modules,
      warnings: [],
    };
  }

  return {
    modules: avoidCuttingSourceBands({
      modules: stitchFlatVerticalRegions({ modules, viewport }),
      sourceBoxes,
      viewport,
    }),
    warnings: [
      "Planner regions were normalized to contiguous full-width vertical bands because no covering fallback/shared layer was present.",
    ],
  };
};

type ModuleOwnershipDraft = NormalizedModuleRegion & {
  candidateNodes: NodeMatch[];
  retainedNodes: NodeMatch[];
  sourceContainerIds: string[];
};

const BACKGROUND_CANDIDATE_TAGS = new Set([
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "use",
]);

type ModuleHit = {
  intersection: number;
  module: ModuleOwnershipDraft;
  score: number;
};

const collectRenderableNodeMatches = ({
  svgLayout,
  viewport,
}: {
  svgLayout?: NormalizeModelPlanInput["svgLayout"];
  viewport: Box;
}) =>
  (svgLayout?.nodes ?? []).flatMap((node, order): NodeMatch[] => {
    if (!isRenderableContentNode(node)) return [];
    const box = nodeBox(node, viewport);
    return box ? [{ box, node, order }] : [];
  });

const collectModuleHits = ({
  match,
  modules,
}: {
  match: NodeMatch;
  modules: ModuleOwnershipDraft[];
}) =>
  modules
    .flatMap((module): ModuleHit[] => {
      const intersection = intersectionArea(match.box, module.region);
      if (intersection <= 0) return [];
      const boxArea = Math.max(1, areaOf(match.box));
      const moduleArea = Math.max(1, areaOf(module.region));
      const overlapOfNode = intersection / boxArea;
      const overlapOfModule = intersection / moduleArea;
      const centerScore = pointInside(centerOf(match.box), module.region) ? 1 : 0;
      if (centerScore === 0 && overlapOfNode < 0.2 && overlapOfModule < 0.2) {
        return [];
      }
      const score = overlapOfNode + overlapOfModule + centerScore;
      return [
        {
          intersection,
          module,
          score,
        },
      ];
    })
    .sort((left, right) => right.score - left.score);

const isCrossModuleSharedBackgroundCandidate = ({
  hits,
  match,
  viewport,
}: {
  hits: ModuleHit[];
  match: NodeMatch;
  viewport: Box;
}) => {
  if (hits.length <= 1) return false;
  if (!BACKGROUND_CANDIDATE_TAGS.has(match.node.tag)) return false;
  if (isPageScaleBox(match.box, viewport.width, viewport.height)) return true;

  const nodeArea = Math.max(1, areaOf(match.box));
  const viewportArea = Math.max(1, areaOf(viewport));
  const broadAcrossPage = match.box.width >= viewport.width * 0.72;
  const largeEnough = nodeArea >= viewportArea * 0.08;
  const tallEnough = match.box.height >= Math.min(900, viewport.height * 0.14);
  const coversMultipleModuleBands = hits.filter((hit) => {
    const moduleArea = Math.max(1, areaOf(hit.module.region));
    return hit.intersection / moduleArea >= 0.2;
  }).length >= 2;

  return broadAcrossPage && largeEnough && (tallEnough || coversMultipleModuleBands);
};

const classifySharedLayerKind = ({
  allMatches,
  match,
}: {
  allMatches: NodeMatch[];
  match: NodeMatch;
}): SvgSharedLayer["kind"] => {
  const peerOrders = allMatches
    .filter(
      (peer) =>
        peer.node.nodePath !== match.node.nodePath &&
        intersectionArea(peer.box, match.box) > 0,
    )
    .map((peer) => peer.order)
    .sort((left, right) => left - right);
  if (!peerOrders.length) return "shared-underlay";

  const laterThanPeerRatio =
    peerOrders.filter((order) => order < match.order).length / peerOrders.length;
  return laterThanPeerRatio >= 0.9 ? "shared-overlay" : "shared-underlay";
};

const clipBoxToViewport = (box: Box, viewport: Box) =>
  toModuleBox(box, viewport) ?? {
    height: Math.max(1, Math.min(box.height, viewport.height)),
    width: Math.max(1, Math.min(box.width, viewport.width)),
    x: clamp(box.x, viewport.x, rightOf(viewport) - 1),
    y: clamp(box.y, viewport.y, bottomOf(viewport) - 1),
  };

const expandBox = ({
  box,
  padding,
  viewport,
}: {
  box: Box;
  padding: number;
  viewport: Box;
}) =>
  clipBoxToViewport(
    {
      height: box.height + padding * 2,
      width: box.width + padding * 2,
      x: box.x - padding,
      y: box.y - padding,
    },
    viewport,
  );

const createSharedLayers = ({
  sharedMatches,
  viewport,
}: {
  sharedMatches: Map<SvgSharedLayer["kind"], NodeMatch[]>;
  viewport: Box;
}): SvgSharedLayer[] =>
  (["shared-underlay", "shared-overlay"] as const).flatMap((kind) => {
    const matches = sharedMatches.get(kind) ?? [];
    if (!matches.length) return [];
    const contentBox = unionBoxes(matches.map((match) => match.box));
    if (!contentBox) return [];
    const id = kind;
    const region = toSerializableRegion(
      id,
      expandBox({ box: contentBox, padding: 4, viewport }),
    );

    return [
      {
        contentBox,
        containsIntrinsicText: false,
        containsText: false,
        id,
        kind,
        nodePaths: uniqueStrings(matches.map((match) => match.node.nodePath)),
        reason:
          "Cross-module background/decorative SVG nodes are rendered once as a shared page layer to preserve paint order without assigning background pieces to semantic modules.",
        region,
        textTreatment: "non-text-shared-asset",
      },
    ];
  });

const assignNodeOwnership = ({
  drafts,
  svgLayout,
  viewport,
}: {
  drafts: ModuleOwnershipDraft[];
  svgLayout?: NormalizeModelPlanInput["svgLayout"];
  viewport: Box;
}) => {
  const allMatches = collectRenderableNodeMatches({ svgLayout, viewport });
  const sharedMatches = new Map<SvgSharedLayer["kind"], NodeMatch[]>();

  allMatches.forEach((match) => {
    const hits = collectModuleHits({ match, modules: drafts });
    if (!hits.length) return;

    if (
      isCrossModuleSharedBackgroundCandidate({
        hits,
        match,
        viewport,
      })
    ) {
      const kind = classifySharedLayerKind({ allMatches, match });
      sharedMatches.set(kind, [...(sharedMatches.get(kind) ?? []), match]);
      return;
    }

    const owner = hits[0]!.module;
    owner.candidateNodes.push(match);
    owner.retainedNodes.push(match);
  });

  return {
    drafts,
    sharedLayers: createSharedLayers({ sharedMatches, viewport }),
  };
};

const repairRegionFromOwnedNodes = ({
  module,
  viewport,
}: {
  module: ModuleOwnershipDraft;
  viewport: Box;
}) => {
  const ownedBox = unionBoxes(module.retainedNodes.map((match) => match.box));
  if (!ownedBox) return module;
  const union = unionBoxes([module.region, ownedBox]);
  if (!union) return module;

  return {
    ...module,
    region: clipBoxToViewport(union, viewport),
  };
};

const containsMostOf = (inner: Region, outer: Region) =>
  intersectionArea(inner, outer) / Math.max(1, areaOf(inner)) >= 0.82;

const isNestedChildModule = (
  parent: Pick<ModuleOwnershipDraft, "region">,
  child: Pick<ModuleOwnershipDraft, "region">,
) =>
  areaOf(parent.region) > areaOf(child.region) * 1.25 &&
  containsMostOf(child.region, parent.region);

const isParentBackgroundNode = ({
  child,
  match,
  parent,
  viewport,
}: {
  child: Pick<ModuleOwnershipDraft, "region">;
  match: NodeMatch;
  parent: Pick<ModuleOwnershipDraft, "region">;
  viewport: Box;
}) => {
  if (!BACKGROUND_CANDIDATE_TAGS.has(match.node.tag)) return false;
  if (isPageScaleBox(match.box, viewport.width, viewport.height)) return true;

  const nodeArea = Math.max(1, areaOf(match.box));
  const childArea = Math.max(1, areaOf(child.region));
  const parentArea = Math.max(1, areaOf(parent.region));
  const nodeCoversParentBand =
    match.box.width >= parent.region.width * 0.75 &&
    match.box.height >= parent.region.height * 0.25 &&
    nodeArea >= parentArea * 0.18;
  const nodeMuchLargerThanChild =
    nodeArea >= childArea * 2 &&
    (match.box.width >= child.region.width * 1.35 ||
      match.box.height >= child.region.height * 1.35);

  return nodeCoversParentBand || nodeMuchLargerThanChild;
};

const filterParentMatches = ({
  childModules,
  matches,
  parent,
  viewport,
}: {
  childModules: ModuleOwnershipDraft[];
  matches: NodeMatch[];
  parent: ModuleOwnershipDraft;
  viewport: Box;
}) => {
  if (!childModules.length) return matches;
  const childNodePaths = new Map<string, ModuleOwnershipDraft>();
  childModules.forEach((child) => {
    child.retainedNodes.forEach((match) => {
      const existing = childNodePaths.get(match.node.nodePath);
      if (!existing || areaOf(child.region) < areaOf(existing.region)) {
        childNodePaths.set(match.node.nodePath, child);
      }
    });
  });

  return matches.filter((match) => {
    const child = childNodePaths.get(match.node.nodePath);
    if (!child) return true;
    return isParentBackgroundNode({
      child,
      match,
      parent,
      viewport,
    });
  });
};

const subtractChildOwnedItems = (
  items: string[],
  childModules: ModuleOwnershipDraft[],
  readChildItems: (child: ModuleOwnershipDraft) => string[],
) => {
  if (!childModules.length) return items;
  const childOwned = new Set(childModules.flatMap(readChildItems));
  return items.filter((item) => !childOwned.has(item));
};

const applyNestedModuleOwnership = ({
  drafts,
  viewport,
}: {
  drafts: ModuleOwnershipDraft[];
  viewport: Box;
}): ModuleOwnershipDraft[] =>
  drafts.map((parent) => {
    const childModules = drafts.filter(
      (candidate) =>
        candidate.id !== parent.id && isNestedChildModule(parent, candidate),
    );
    if (!childModules.length) return parent;

    return {
      ...parent,
      candidateNodes: filterParentMatches({
        childModules,
        matches: parent.candidateNodes,
        parent,
        viewport,
      }),
      retainedNodes: filterParentMatches({
        childModules,
        matches: parent.retainedNodes,
        parent,
        viewport,
      }),
      sourceContainerIds: subtractChildOwnedItems(
        parent.sourceContainerIds,
        childModules,
        (child) => child.sourceContainerIds,
      ),
    };
  });

const isTinyEmptyModule = ({
  module,
  viewport,
}: {
  module: ModuleOwnershipDraft;
  viewport: Box;
}) => {
  if (
    module.candidateNodes.length ||
    module.retainedNodes.length
  ) {
    return false;
  }

  const tinyHeight = module.region.height <= Math.max(12, viewport.height * 0.012);
  const tinyArea = areaOf(module.region) <= areaOf(viewport) * 0.012;
  return tinyHeight || tinyArea;
};

const removeTinyEmptyModules = ({
  modules,
  viewport,
}: {
  modules: ModuleOwnershipDraft[];
  viewport: Box;
}) =>
  modules.filter((module) => !isTinyEmptyModule({ module, viewport }));

const toSvgVerticalModule = ({
  module,
  viewport,
}: {
  module: ModuleOwnershipDraft;
  viewport: Box;
}): SvgVerticalModule => {
  const region = toSerializableRegion(module.id, module.region);
  const contentBox =
    unionBoxes(module.retainedNodes.map((match) => match.box)) ??
    unionBoxes(module.candidateNodes.map((match) => match.box)) ??
    {
      height: region.height,
      width: region.width,
      x: region.x,
      y: region.y,
    };

  return {
    candidateNodeCount: module.candidateNodes.length,
    contentBox,
    diffRegion: expandRegion({
      id: module.id,
      padding: 4,
      region,
      viewport,
    }),
    id: module.id,
    kind: module.kind,
    nodePaths: uniqueStrings(
      (module.retainedNodes.length ? module.retainedNodes : module.candidateNodes).map(
        (match) => match.node.nodePath,
      ),
    ),
    reason: module.reason,
    region,
    score: 0,
    sourceContainerIds: module.sourceContainerIds,
  };
};

const countIgnoredRenderableNodes = ({
  modules,
  sharedLayers,
  svgLayout,
  viewport,
}: {
  modules: SvgVerticalModule[];
  sharedLayers: SvgSharedLayer[];
  svgLayout?: NormalizeModelPlanInput["svgLayout"];
  viewport: Box;
}) => {
  const regions = [
    ...modules.map((module) => module.region),
    ...sharedLayers.map((layer) => layer.region),
  ];
  return (svgLayout?.nodes ?? []).filter((node) => {
    if (!isRenderableContentNode(node)) return false;
    const box = nodeBox(node, viewport);
    if (!box) return false;
    return !regions.some((region) => intersectsRegion(box, region));
  }).length;
};

const normalizeModelPlan = ({
  containerLayout,
  response,
  svgLayout,
  validation,
  viewport,
}: NormalizeModelPlanInput): PlannedModules => {
  const sourceBoxes = collectValidationSourceBoxes({
    containerLayout,
    viewport,
  });
  const safeYLines = collectSafeYLines({
    sourceBoxes,
    viewport,
  });
  const normalizedRegionDrafts = (response.modules ?? [])
    .map((module, index) =>
      normalizeRegion({
        index,
        module,
        safeYLines,
        viewport,
      }),
    )
    .sort(
      (left, right) =>
        left.region.y - right.region.y || left.region.x - right.region.x,
    )
    .map((module, index) => ({
      ...module,
      id: `module-${String(index + 1).padStart(2, "0")}`,
    }));
  const boundaryRepair = repairRegionsAwayFromSourceBoxes({
    regions: normalizedRegionDrafts.map((module) => ({
      ...module.region,
      id: module.id,
    })),
    sourceBoxes,
    viewport,
  });
  const boundaryRepairedRegionDrafts = normalizedRegionDrafts.map(
    (module, index) => ({
      ...module,
      region: boundaryRepair.regions[index] ?? module.region,
    }),
  );
  const coverage = normalizeTopLevelCoverage({
    modules: boundaryRepairedRegionDrafts,
    sourceBoxes,
    viewport,
  });
  const normalizedRegions = coverage.modules.map((module, index) => ({
    ...module,
    id: `module-${String(index + 1).padStart(2, "0")}`,
  }));
  const ownershipDrafts = normalizedRegions.map((module): ModuleOwnershipDraft => {
    const region = toSerializableRegion(module.id, module.region);
    const sourceContainerIds = sourceContainerIdsForRegion({
      containerLayout,
      region,
      viewport,
    });

    return {
      ...module,
      candidateNodes: [],
      retainedNodes: [],
      sourceContainerIds,
    };
  });
  const ownership = assignNodeOwnership({
    drafts: ownershipDrafts,
    svgLayout,
    viewport,
  });
  const repairedDrafts = ownership.drafts.map((module) =>
    repairRegionFromOwnedNodes({ module, viewport }),
  );
  const refreshedDrafts = repairedDrafts.map((module) => {
      const region = toSerializableRegion(module.id, module.region);
      const sourceContainerIds = sourceContainerIdsForRegion({
        containerLayout,
        region,
        viewport,
      });
      return {
        ...module,
        sourceContainerIds,
      };
    });
  const ownedDrafts = applyNestedModuleOwnership({
    drafts: refreshedDrafts,
    viewport,
  });
  const filteredDrafts = removeTinyEmptyModules({
    modules: ownedDrafts,
    viewport,
  }).map((module, index) => ({
    ...module,
    id: `module-${String(index + 1).padStart(2, "0")}`,
  }));
  const modules = filteredDrafts.map((module) =>
    toSvgVerticalModule({
      module,
      viewport,
    }),
  );

  return {
    gaps: [],
    ignoredNodeCount: countIgnoredRenderableNodes({
      modules,
      sharedLayers: ownership.sharedLayers,
      svgLayout,
      viewport,
    }),
    modules,
    sharedLayers: ownership.sharedLayers,
    strategy:
      response.strategy?.trim() ||
      "Model planner: semantic visual module regions from screenshot review.",
    warnings: [
      ...validation.warnings.map((warning) => warning.message),
      ...boundaryRepair.repairs.map(
        (repair) =>
          `${repair.id} ${repair.side} boundary auto-snapped from ${repair.from} to ${repair.to} to avoid cutting source boxes.`,
      ),
      ...coverage.warnings,
    ],
  };
};

export { normalizeModelPlan };
