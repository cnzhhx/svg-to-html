import {
  areaOf,
  bottomOf,
  centerOf,
  intersectionArea,
  isPageScaleBox,
  overlapLength,
  pointInside,
  rightOf,
  round,
  unionBoxes,
} from "../geometry.js";
import type { Box, Region } from '../geometry.js';
import { isRecord } from '../type-guards.js';
import type {
  ModuleKind,
  ModelPlannerModule,
  ModulePlanValidationIssue,
  ModulePlanValidationResult,
  ValidateModelPlanInput,
  ValidationSourceBox,
} from "./types.js";

const ALLOWED_MODULE_KINDS = new Set<ModuleKind>([
  "global-shell",
  "section",
  "header",
  "sidebar",
  "main",
  "right-panel",
  "list-grid",
  "overlay",
  "model-region",
]);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const overlapsEnough = ({
  edgeEnd,
  edgeStart,
  sourceEnd,
  sourceStart,
}: {
  edgeEnd: number;
  edgeStart: number;
  sourceEnd: number;
  sourceStart: number;
}) => {
  const sourceLength = Math.max(1, sourceEnd - sourceStart);
  return overlapLength(edgeStart, edgeEnd, sourceStart, sourceEnd) / sourceLength >= 0.45;
};

const createIssue = (
  severity: ModulePlanValidationIssue["severity"],
  code: string,
  message: string,
  extra: Partial<ModulePlanValidationIssue> = {},
): ModulePlanValidationIssue => ({
  code,
  message,
  severity,
  ...extra,
});

const normalizeKind = (kind: unknown): ModuleKind => {
  if (typeof kind === "string" && ALLOWED_MODULE_KINDS.has(kind as ModuleKind)) {
    return kind as ModuleKind;
  }
  return "model-region";
};

const stripJsonMarkdown = (raw: string) => {
  let content = raw.trim();
  // Strip <think>...</think> tags (reasoning content from some models)
  content = content.replace(/<think>.*?<\/think>/gs, "");
  content = content.replace(/<think>/g, "");
  content = content.replace(/<\/think>/g, "");
  content = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end > start ? content.slice(start, end + 1) : content;
};

const parseModelPlannerResponse = (raw: string) => {
  const jsonText = stripJsonMarkdown(raw);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return { jsonText, response: parsed };
  } catch (error) {
    return {
      error: createIssue(
        "error",
        "json-parse-failed",
        `Planner response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
      jsonText,
    };
  }
};

const readRegion = ({
  index,
  module,
}: {
  index: number;
  module: ModelPlannerModule;
}) => {
  const id = typeof module.id === "string" && module.id.trim()
    ? module.id.trim()
    : `modules[${index}]`;
  if (!isRecord(module.region)) {
    return {
      errors: [
        createIssue("error", "region-missing", `${id} is missing region.`, {
          regionIds: [id],
        }),
      ],
      id,
      region: null,
    };
  }

  const values = {
    height: module.region["height"],
    width: module.region["width"],
    x: module.region["x"],
    y: module.region["y"],
  };
  const invalidFields = Object.entries(values)
    .filter(([, value]) => !isFiniteNumber(value))
    .map(([field]) => field);
  if (invalidFields.length) {
    return {
      errors: [
        createIssue(
          "error",
          "region-field-invalid",
          `${id} has non-numeric region field(s): ${invalidFields.join(", ")}.`,
          {
            details: { invalidFields },
            regionIds: [id],
          },
        ),
      ],
      id,
      region: null,
    };
  }

  return {
    errors: [],
    id,
    region: values as Region,
  };
};

const GRAPHIC_NODE_TAGS = new Set([
  "circle", "ellipse", "g", "image", "line",
  "path", "polygon", "polyline", "rect", "use",
]);

const isGraphicOnlyMembers = (paths: string[]) =>
  paths.every((p) => {
    const lastSegment = p.split(" > ").pop() ?? "";
    const tag = lastSegment.replace(/:nth-of-type\(\d+\)$/, "");
    return GRAPHIC_NODE_TAGS.has(tag);
  });

const isDecorativeBackground = (
  container: { box: Box; childContainerIds: string[]; descendantCount: number; directMemberNodePaths: string[]; kind: string },
  viewport: Box,
): boolean => {
  if (container.kind === "root") return false;
  const { box } = container;
  const nearFullWidth = box.width >= viewport.width * 0.85;
  const tallEnough = box.height >= viewport.height * 0.25;
  if (!nearFullWidth || !tallEnough) return false;

  const extendsOutside =
    box.x < -viewport.width * 0.05 ||
    box.y < -viewport.height * 0.02 ||
    box.x + box.width > viewport.width * 1.1;
  if (extendsOutside) return true;

  if (container.childContainerIds.length > 0 || container.descendantCount > 2) return false;
  const members = container.directMemberNodePaths;
  if (members.length === 0) return true;
  return isGraphicOnlyMembers(members);
};

const isMeaningfulBox = (box: Box, viewport: Box) =>
  box.width >= 8 &&
  box.height >= 8 &&
  areaOf(box) >= 80 &&
  !isPageScaleBox(box, viewport.width, viewport.height);

const isLargeBackgroundLikeBox = (box: Box, viewport: Box) => {
  const nearFullWidth = box.width >= viewport.width * 0.85;
  const tall = box.height >= Math.min(900, viewport.height * 0.16);
  const oversized = box.width > viewport.width * 1.05 || box.x < -viewport.width * 0.1;
  const largeArea = areaOf(box) >= areaOf(viewport) * 0.08;
  return nearFullWidth && tall && (oversized || largeArea);
};

const collectValidationSourceBoxes = ({
  containerLayout,
  viewport,
}: Pick<ValidateModelPlanInput, "containerLayout" | "viewport">): ValidationSourceBox[] => {
  const sourceBoxes: ValidationSourceBox[] = [];

  const containersById = new Map(
    (containerLayout?.containers ?? []).map((container) => [container.id, container] as const),
  );
  (containerLayout?.containers ?? []).forEach((container) => {
    if (container.kind === "root") return;
    if (!isMeaningfulBox(container.box, viewport)) return;
    if (isDecorativeBackground(container, viewport)) return;
    sourceBoxes.push({
      box: container.box,
      id: container.id,
      kind: "container",
    });
  });

  (containerLayout?.repeatedGroups ?? []).forEach((group, index) => {
    const boxes = group.containerIds
      .map((id) => containersById.get(id)?.box)
      .filter((box): box is Box => Boolean(box));
    const box = unionBoxes(boxes);
    if (!box || !isMeaningfulBox(box, viewport)) return;
    sourceBoxes.push({
      box,
      id: `repeat-group-${index + 1}`,
      kind: "repeat-group",
    });
  });

  return sourceBoxes;
};

const sourceBoxCoveredByRegion = (sourceBox: Box, regions: Region[]) =>
  regions.some((region) => {
    const sourceArea = Math.max(1, areaOf(sourceBox));
    return (
      pointInside(centerOf(sourceBox), region) ||
      intersectionArea(sourceBox, region) / sourceArea >= 0.2
    );
  });

const collectCoverageIssues = ({
  regions,
  sourceBoxes,
}: {
  regions: Region[];
  sourceBoxes: ValidationSourceBox[];
}) => {
  const coverageBoxes = sourceBoxes.filter((sourceBox) => sourceBox.kind !== "repeat-group");
  const uncovered = coverageBoxes.filter(
    (sourceBox) => !sourceBoxCoveredByRegion(sourceBox.box, regions),
  );
  if (!coverageBoxes.length || !uncovered.length) {
    return {
      issues: [],
      sourceCoverage: {
        coveredCount: coverageBoxes.length - uncovered.length,
        sourceBoxCount: coverageBoxes.length,
        uncoveredIds: uncovered.map((sourceBox) => sourceBox.id),
      },
    };
  }

  const uncoveredRatio = uncovered.length / coverageBoxes.length;
  const severity = uncoveredRatio > 0.18 && uncovered.length > 3 ? "error" : "warning";
  return {
    issues: [
      createIssue(
        severity,
        "source-coverage-low",
        `${uncovered.length}/${coverageBoxes.length} container/shell source box(es) are not covered by any proposed module.`,
        {
          details: {
            uncoveredIds: uncovered.slice(0, 30).map((sourceBox) => sourceBox.id),
            uncoveredRatio: round(uncoveredRatio),
          },
        },
      ),
    ],
    sourceCoverage: {
      coveredCount: coverageBoxes.length - uncovered.length,
      sourceBoxCount: coverageBoxes.length,
      uncoveredIds: uncovered.slice(0, 50).map((sourceBox) => sourceBox.id),
    },
  };
};

const collectSingleHugeModuleIssues = ({
  regions,
  sourceBoxes,
  viewport,
}: {
  regions: Array<Region & { id?: string }>;
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  if (regions.length !== 1) return [];
  const region = regions[0]!;
  const sourceBoxCount = sourceBoxes.filter(
    (sourceBox) => sourceBox.kind !== "repeat-group",
  ).length;
  const contentRich =
    sourceBoxCount >= 70 ||
    (sourceBoxCount >= 30 && viewport.height >= viewport.width * 1.45) ||
    (sourceBoxCount >= 45 && viewport.height >= 900);
  if (!contentRich) return [];

  const viewportArea = Math.max(1, areaOf(viewport));
  const coverage = intersectionArea(region, viewport) / viewportArea;
  if (coverage < 0.9) return [];

  return [
    createIssue(
      "error",
      viewport.height > 3500
        ? "single-huge-module-for-tall-design"
        : "single-page-module-for-content-rich-design",
      "Content-rich designs must be split into multiple semantic modules instead of one page-sized module. Use semantic rough regions; deterministic geometry repair will snap imprecise pixel boundaries.",
      {
        details: {
          designHeight: viewport.height,
          sourceBoxCount,
        },
        regionIds: [region.id ?? "module-01"],
      },
    ),
  ];
};

const collectTallModuleIssues = ({
  regions,
  sourceBoxes,
  viewport,
}: {
  regions: Array<Region & { id?: string }>;
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  if (viewport.height <= 3500) return [];
  const sourceBoxCount = sourceBoxes.filter(
    (sourceBox) => sourceBox.kind !== "repeat-group",
  ).length;
  if (sourceBoxCount < 20) return [];

  const maxHeight = Math.min(2400, viewport.height * 0.45);
  return regions
    .filter((region) => region.height > maxHeight)
    .map((region, index) =>
      createIssue(
        "error",
        "module-too-tall-for-tall-design",
        `Module ${region.id ?? `module-${index + 1}`} is ${round(region.height)}px tall; tall, content-rich designs need smaller semantic modules.`,
        {
          details: {
            maxRecommendedHeight: round(maxHeight),
            moduleHeight: round(region.height),
          },
          regionIds: [region.id ?? `module-${index + 1}`],
        },
      ),
    );
};

type RegionEdge = {
  id: string;
  max: number;
  min: number;
  orientation: "horizontal" | "vertical";
  value: number;
};

const collectRegionEdges = (regions: Array<Region & { id?: string }>, viewport: Box) => {
  const tolerance = 2;
  const edges: RegionEdge[] = [];
  regions.forEach((region, index) => {
    const id = region.id ?? `module-${index + 1}`;
    const left = region.x;
    const right = rightOf(region);
    const top = region.y;
    const bottom = bottomOf(region);
    if (Math.abs(top - viewport.y) > tolerance) {
      edges.push({
        id,
        max: right,
        min: left,
        orientation: "horizontal",
        value: top,
      });
    }
    if (Math.abs(bottom - bottomOf(viewport)) > tolerance) {
      edges.push({
        id,
        max: right,
        min: left,
        orientation: "horizontal",
        value: bottom,
      });
    }
    if (Math.abs(left - viewport.x) > tolerance) {
      edges.push({
        id,
        max: bottom,
        min: top,
        orientation: "vertical",
        value: left,
      });
    }
    if (Math.abs(right - rightOf(viewport)) > tolerance) {
      edges.push({
        id,
        max: bottom,
        min: top,
        orientation: "vertical",
        value: right,
      });
    }
  });
  return edges;
};

const edgeCutsBox = (edge: RegionEdge, box: Box) => {
  const inset = Math.min(8, Math.max(2, Math.min(box.width, box.height) * 0.18));
  if (edge.orientation === "horizontal") {
    return (
      edge.value > box.y + inset &&
      edge.value < bottomOf(box) - inset &&
      overlapsEnough({
        edgeEnd: edge.max,
        edgeStart: edge.min,
        sourceEnd: rightOf(box),
        sourceStart: box.x,
      })
    );
  }

  return (
    edge.value > box.x + inset &&
    edge.value < rightOf(box) - inset &&
    overlapsEnough({
      edgeEnd: edge.max,
      edgeStart: edge.min,
      sourceEnd: bottomOf(box),
      sourceStart: box.y,
    })
  );
};

type BoundaryRepair = {
  from: number;
  id: string;
  side: "bottom" | "left" | "right" | "top";
  sourceBoxIds: string[];
  to: number;
};

const boundaryRepairTolerance = (viewport: Box) =>
  Math.min(180, Math.max(64, Math.min(viewport.width, viewport.height) * 0.12));

const collectRepairableSourceBoxes = ({
  sourceBoxes,
  viewport,
}: {
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) =>
  sourceBoxes.filter(
    (sourceBox) =>
      !(
        sourceBox.kind === "container" &&
        isLargeBackgroundLikeBox(sourceBox.box, viewport)
      ),
  );

const collectRegionEdgesForRepair = (
  region: Region & { id?: string },
  viewport: Box,
) => {
  const tolerance = 2;
  const id = region.id ?? "module";
  const left = region.x;
  const right = rightOf(region);
  const top = region.y;
  const bottom = bottomOf(region);
  const edges: Array<RegionEdge & { side: BoundaryRepair["side"] }> = [];

  if (Math.abs(top - viewport.y) > tolerance) {
    edges.push({
      id,
      max: right,
      min: left,
      orientation: "horizontal",
      side: "top",
      value: top,
    });
  }
  if (Math.abs(bottom - bottomOf(viewport)) > tolerance) {
    edges.push({
      id,
      max: right,
      min: left,
      orientation: "horizontal",
      side: "bottom",
      value: bottom,
    });
  }
  if (Math.abs(left - viewport.x) > tolerance) {
    edges.push({
      id,
      max: bottom,
      min: top,
      orientation: "vertical",
      side: "left",
      value: left,
    });
  }
  if (Math.abs(right - rightOf(viewport)) > tolerance) {
    edges.push({
      id,
      max: bottom,
      min: top,
      orientation: "vertical",
      side: "right",
      value: right,
    });
  }

  return edges;
};

const collectSeamEdges = (
  boxes: ValidationSourceBox[],
  side: BoundaryRepair["side"],
) =>
  side === "top" || side === "bottom"
    ? boxes.flatMap((source) => [source.box.y, bottomOf(source.box)])
    : boxes.flatMap((source) => [source.box.x, rightOf(source.box)]);

const proposedBoundary = ({
  edgeValue,
  boxes,
  side,
}: {
  edgeValue: number;
  boxes: ValidationSourceBox[];
  side: BoundaryRepair["side"];
}) => {
  if (!boxes.length) return undefined;
  // Every crossing box contributes BOTH of its perpendicular edges as snap
  // candidates. The old "min(all starts), max(all ends)" reduction collapsed
  // every box's inner edges and could snap a boundary onto a far-side box's
  // outer edge, swallowing every box in between. Picking the nearest edge per
  // box mirrors normalize-plan's avoidCuttingSourceBands fix.
  const candidates = collectSeamEdges(boxes, side);
  return candidates
    .map((candidate) => ({
      candidate,
      distance: Math.abs(candidate - edgeValue),
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;
};

const applyBoundaryRepair = <T extends Region & { id?: string }>({
  proposed,
  region,
  side,
  viewport,
}: {
  proposed: number;
  region: T;
  side: BoundaryRepair["side"];
  viewport: Box;
}) => {
  const minSize = 1;
  if (side === "top") {
    const next = Math.max(viewport.y, Math.min(proposed, bottomOf(region) - minSize));
    region.height = bottomOf(region) - next;
    region.y = next;
    return next;
  }
  if (side === "bottom") {
    const next = Math.min(
      bottomOf(viewport),
      Math.max(proposed, region.y + minSize),
    );
    region.height = next - region.y;
    return next;
  }
  if (side === "left") {
    const next = Math.max(viewport.x, Math.min(proposed, rightOf(region) - minSize));
    region.width = rightOf(region) - next;
    region.x = next;
    return next;
  }

  const next = Math.min(
    rightOf(viewport),
    Math.max(proposed, region.x + minSize),
  );
  region.width = next - region.x;
  return next;
};

const repairRegionsAwayFromSourceBoxes = <T extends Region & { id?: string }>({
  regions,
  sourceBoxes,
  viewport,
}: {
  regions: T[];
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  const tolerance = boundaryRepairTolerance(viewport);
  const repairableSourceBoxes = collectRepairableSourceBoxes({
    sourceBoxes,
    viewport,
  });
  const repaired = regions.map((region) => ({ ...region }) as T);
  const repairs: BoundaryRepair[] = [];

  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const region of repaired) {
      const edges = collectRegionEdgesForRepair(region, viewport);
      for (const edge of edges) {
        const crossing = repairableSourceBoxes.filter((sourceBox) =>
          edgeCutsBox(edge, sourceBox.box),
        );
        const proposed = proposedBoundary({
          edgeValue: edge.value,
          boxes: crossing,
          side: edge.side,
        });
        if (proposed === undefined) continue;
        if (Math.abs(proposed - edge.value) > tolerance) continue;

        const next = applyBoundaryRepair({
          proposed,
          region,
          side: edge.side,
          viewport,
        });
        if (Math.abs(next - edge.value) <= 0.001) continue;

        repairs.push({
          from: round(edge.value),
          id: edge.id,
          side: edge.side,
          sourceBoxIds: crossing.slice(0, 8).map((sourceBox) => sourceBox.id),
          to: round(next),
        });
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    regions: repaired,
    repairs,
  };
};

const createBoundaryRepairWarnings = (repairs: BoundaryRepair[]) =>
  repairs.slice(0, 16).map((repair) =>
    createIssue(
      "warning",
      "boundary-auto-repaired",
      `${repair.id} ${repair.side} boundary auto-snapped from ${repair.from} to ${repair.to} to avoid cutting source boxes.`,
      {
        details: repair,
        regionIds: [repair.id],
      },
    ),
  );

const collectCutIssues = ({
  regions,
  sourceBoxes,
  viewport,
}: {
  regions: Array<Region & { id?: string }>;
  sourceBoxes: ValidationSourceBox[];
  viewport: Box;
}) => {
  const issues: ModulePlanValidationIssue[] = [];
  const edges = collectRegionEdges(regions, viewport);
  const seen = new Set<string>();

  for (const edge of edges) {
    for (const sourceBox of sourceBoxes) {
      if (!edgeCutsBox(edge, sourceBox.box)) continue;
      if (
        sourceBox.kind === "container" &&
        isLargeBackgroundLikeBox(sourceBox.box, viewport)
      ) {
        continue;
      }
      const severity =
        sourceBox.kind === "repeat-group" ? "error" : "warning";
      const code =
        sourceBox.kind === "repeat-group"
          ? "cuts-through-repeat-group"
          : "cuts-through-container";
      const key = `${severity}:${code}:${edge.id}:${sourceBox.id}:${edge.orientation}:${round(edge.value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(
        createIssue(
          severity,
          code,
          `${edge.id} ${edge.orientation} boundary at ${round(edge.value)} cuts through ${sourceBox.kind} ${sourceBox.id}.`,
          {
            details: {
              boundary: round(edge.value),
              orientation: edge.orientation,
              sourceBoxId: sourceBox.id,
              sourceBoxKind: sourceBox.kind,
            },
            regionIds: [edge.id],
          },
        ),
      );
      if (issues.length >= 40) return issues;
    }
  }

  return issues;
};

const validateRegionBasics = ({
  modules,
  viewport,
}: {
  modules: ModelPlannerModule[];
  viewport: Box;
}) => {
  const issues: ModulePlanValidationIssue[] = [];
  const regions: Array<Region & { id?: string; kind: ModuleKind }> = [];
  const tolerance = 4;

  modules.forEach((module, index) => {
    const { errors, id, region } = readRegion({ index, module });
    issues.push(...errors);
    if (!region) return;

    const kind = normalizeKind(module.kind);
    if (region.width <= 0 || region.height <= 0) {
      issues.push(
        createIssue("error", "region-size-invalid", `${id} has non-positive size.`, {
          regionIds: [id],
        }),
      );
      return;
    }

    if (
      region.x < viewport.x - tolerance ||
      region.y < viewport.y - tolerance ||
      rightOf(region) > rightOf(viewport) + tolerance ||
      bottomOf(region) > bottomOf(viewport) + tolerance
    ) {
      const clippedArea = intersectionArea(region, viewport);
      if (clippedArea > 0) {
        issues.push(
          createIssue(
            "warning",
            "region-clamped-to-viewport",
            `${id} extends outside the design viewport and will be clamped during normalization.`,
            {
              details: { clippedArea: round(clippedArea), region },
              regionIds: [id],
            },
          ),
        );
      } else {
      issues.push(
        createIssue("error", "region-out-of-bounds", `${id} is outside the design viewport.`, {
          details: { region },
          regionIds: [id],
        }),
      );
      }
    }

    if (
      typeof module.kind === "string" &&
      !ALLOWED_MODULE_KINDS.has(module.kind as ModuleKind)
    ) {
      issues.push(
        createIssue(
          "warning",
          "kind-normalized",
          `${id} uses unknown kind "${module.kind}"; it will be normalized to model-region.`,
          { regionIds: [id] },
        ),
      );
    }

    regions.push({ ...region, id, kind });
  });

  return { issues, regions };
};

const summarizeValidation = (
  issues: ModulePlanValidationIssue[],
  sourceCoverage?: ModulePlanValidationResult["sourceCoverage"],
): ModulePlanValidationResult => {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    errorCount: errors.length,
    errors,
    passed: errors.length === 0,
    sourceCoverage,
    warningCount: warnings.length,
    warnings,
  };
};

const validateModelPlan = ({
  containerLayout,
  response,
  viewport,
}: ValidateModelPlanInput): ModulePlanValidationResult => {
  const issues: ModulePlanValidationIssue[] = [];
  if (!isRecord(response)) {
    return summarizeValidation([
      createIssue("error", "response-not-object", "Planner response must be a JSON object."),
    ]);
  }

  const modules = response["modules"];
  if (!Array.isArray(modules)) {
    return summarizeValidation([
      createIssue("error", "modules-not-array", "Planner response must include modules array."),
    ]);
  }

  if (!modules.length) {
    issues.push(createIssue("error", "modules-empty", "Planner response has no modules."));
  }
  const moduleRecords = modules.filter((module): module is ModelPlannerModule => {
    if (isRecord(module)) return true;
    issues.push(
      createIssue("error", "module-not-object", "Each module entry must be a JSON object."),
    );
    return false;
  });
  const basics = validateRegionBasics({
    modules: moduleRecords,
    viewport,
  });
  issues.push(...basics.issues);

  const sourceBoxes = collectValidationSourceBoxes({
    containerLayout,
    viewport,
  });
  const boundaryRepair = repairRegionsAwayFromSourceBoxes({
    regions: basics.regions,
    sourceBoxes,
    viewport,
  });
  const repairedRegions = boundaryRepair.regions;
  const coverage = collectCoverageIssues({
    regions: repairedRegions,
    sourceBoxes,
  });

  issues.push(...coverage.issues);
  issues.push(...createBoundaryRepairWarnings(boundaryRepair.repairs));
  issues.push(...collectSingleHugeModuleIssues({
    regions: repairedRegions,
    sourceBoxes,
    viewport,
  }));
  issues.push(...collectTallModuleIssues({
    regions: repairedRegions,
    sourceBoxes,
    viewport,
  }));
  issues.push(...collectCutIssues({
    regions: repairedRegions,
    sourceBoxes,
    viewport,
  }));

  return summarizeValidation(issues, coverage.sourceCoverage);
};

export {
  collectValidationSourceBoxes,
  isLargeBackgroundLikeBox,
  normalizeKind as normalizeModuleKind,
  parseModelPlannerResponse,
  repairRegionsAwayFromSourceBoxes,
  validateModelPlan,
};
