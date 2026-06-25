import path from "node:path";

import {
  readSvgLayout,
  type SvgLayoutNode,
  type SvgLayoutResult,
} from "../svg-layout.js";
import { resolveArtifactDir } from "../paths.js";
import { resolveSvgDesign } from "../design-resolve.js";
import { writeJsonFile, writeTextFile } from "../file-io.js";
import {
  buildExplicitContainers,
  createAssignments,
  getSmallestContainingShape,
  inferMemberAlignments,
  mergeOverlappingShellAssignments,
  resolveEntryChildren,
  resolveParentContainerId,
} from "./containers.js";
import {
  buildRepeatedGroups,
  createRebuildRecipes,
  detectCellRows,
  detectRepeatGroupPatterns,
  detectShellCandidates,
  isResourceNodePath,
} from "./patterns.js";
import { createReport } from "./report.js";

import type {
  ContainerLayoutReport,
  ContainerRecord,
  ShapeContainerMeta,
} from "./types.js";

const resolveContainerTree = ({
  designArea,
  svgNodes,
}: {
  designArea: number;
  svgNodes: SvgLayoutNode[];
}) => {
  // This is the orchestration layer: collect possible containers first, then
  // assign leaves and normalize entry children for downstream module planning.
  const svgNodesByPath = new Map(
    svgNodes.map((node) => [node.nodePath, node] as const),
  );
  const nodesByParent = new Map<string, SvgLayoutNode[]>();
  svgNodes.forEach((node) => {
    const { parentPath } = node;
    if (!parentPath) return;
    const bucket = nodesByParent.get(parentPath) ?? [];
    bucket.push(node);
    nodesByParent.set(parentPath, bucket);
  });

  const explicitContainers = buildExplicitContainers(svgNodes);
  const shapeContainersByPath = new Map<string, ShapeContainerMeta>();
  svgNodes.forEach((node) => {
    const shapeContainer = getSmallestContainingShape(node, nodesByParent);
    if (!shapeContainer) return;
    if (!shapeContainersByPath.has(shapeContainer.nodePath))
      shapeContainersByPath.set(shapeContainer.nodePath, shapeContainer);
  });

  const containerPool = [
    ...explicitContainers,
    ...shapeContainersByPath.values(),
  ].sort(
    (left, right) =>
      left.depth - right.depth || left.nodePath.localeCompare(right.nodePath),
  );

  const containers: ContainerRecord[] = containerPool.map(
    (container, index) => ({
      box: container.box,
      childContainerIds: [],
      depth: container.depth,
      descendantCount:
        "descendantCount" in container ? container.descendantCount : 0,
      directMemberNodePaths: [],
      id: `c${index}`,
      kind: container.kind,
      nodePath: container.nodePath,
      parentContainerId: null,
      reasons: container.reasons,
      score: container.score,
      tag: container.tag,
    }),
  );

  const rootContainer = containers.find(
    (container) => container.kind === "root",
  );
  if (!rootContainer) throw new Error("Failed to resolve svg root container");
  const containerByNodePath = new Map(
    containers.map((container) => [container.nodePath, container] as const),
  );

  containers.forEach((container, index) => {
    const sourceContainer = containerPool[index];
    if (!sourceContainer || container.kind === "root") return;
    container.parentContainerId = resolveParentContainerId({
      container: sourceContainer,
      containerByNodePath,
      rootContainerId: rootContainer.id,
      svgNodesByPath,
    });
  });

  const assignments = createAssignments({
    containers,
    nodesByParent,
    rootContainerId: rootContainer.id,
    svgNodes,
  });
  mergeOverlappingShellAssignments({
    assignments,
    containers,
    nodesByParent,
    svgNodesByPath,
  });

  const containerById = new Map(
    containers.map((container) => [container.id, container] as const),
  );
  const containerNodePaths = new Set(
    containers.map((container) => container.nodePath),
  );

  assignments.forEach((assignment) => {
    const container = containerById.get(assignment.assignedContainerId);
    if (!container) return;
    if (containerNodePaths.has(assignment.nodePath)) return;
    container.directMemberNodePaths.push(assignment.nodePath);
  });

  containers.forEach((container) => {
    if (!container.parentContainerId) return;
    const parent = containerById.get(container.parentContainerId);
    if (!parent) return;
    parent.childContainerIds.push(container.id);
  });

  containers.forEach((container) => {
    container.childContainerIds.sort((left, right) => {
      const leftContainer = containerById.get(left);
      const rightContainer = containerById.get(right);
      if (!leftContainer || !rightContainer) return left.localeCompare(right);
      return (
        leftContainer.box.y - rightContainer.box.y ||
        leftContainer.box.x - rightContainer.box.x ||
        left.localeCompare(right)
      );
    });
    container.directMemberNodePaths.sort();
  });

  const repeatedGroups = buildRepeatedGroups(containers);
  const allRepeatedGroupPatterns = detectRepeatGroupPatterns(repeatedGroups);
  const repeatGroupPatterns = allRepeatedGroupPatterns.filter((pattern) => {
    const firstTarget = containers.find(
      (container) => container.id === pattern.containerIds[0],
    );
    if (!firstTarget) return false;
    return firstTarget.box.width >= 120 || firstTarget.box.height >= 60;
  });
  const rootChildren = [...rootContainer.childContainerIds];
  const patterns = [
    ...detectCellRows(containers),
    ...repeatGroupPatterns,
    ...detectShellCandidates({
      containers,
      designArea,
      repeatedGroups,
    }),
  ];
  const recipes = createRebuildRecipes({
    containers,
    patterns,
  });
  const assignedNodePaths = new Set(
    assignments.map((assignment) => assignment.nodePath),
  );

  const memberAlignments = inferMemberAlignments({
    containers,
    svgNodes,
  });

  return {
    assignments,
    containers,
    entryChildren: resolveEntryChildren({
      containers,
      rootChildren,
    }),
    memberAlignments,
    nodeCount: svgNodes.length,
    patterns,
    recipes,
    repeatedGroups,
    rootChildren,
    unassignedNodePaths: svgNodes
      .filter(
        (node) =>
          !assignedNodePaths.has(node.nodePath) &&
          node.nodePath !== rootContainer.nodePath,
      )
      .map((node) => node.nodePath),
  };
};

const createContainerLayoutReport = async ({
  artifactDir: customArtifactDir,
  inputPath,
  scale,
  svgLayout: providedSvgLayout,
}: {
  artifactDir?: string;
  inputPath: string;
  scale?: number;
  svgLayout?: SvgLayoutResult;
}) => {
  const design = await resolveSvgDesign(inputPath, { scale });
  const artifactDir = await resolveArtifactDir(inputPath, customArtifactDir);
  const svgLayout =
    providedSvgLayout ??
    (
      await readSvgLayout({
        design,
        wrapperRoot: artifactDir,
      })
    ).result;

  const svgNodes = svgLayout.nodes.filter(
    (node) => node.pixelBox && !isResourceNodePath(node.nodePath),
  );
  const resolved = resolveContainerTree({
    designArea: design.width * design.height,
    svgNodes,
  });
  const report: ContainerLayoutReport = {
    ...resolved,
    svgPath: design.svgPath,
  };
  const outputPath = path.join(artifactDir, "container-layout.json");
  const markdownPath = path.join(artifactDir, "container-layout.md");

  await writeJsonFile(outputPath, report);
  await writeTextFile(markdownPath, createReport(report));

  return {
    artifactDir,
    markdownPath,
    outputPath,
    report,
    svgLayout,
    svgNodeCount: svgLayout.nodeCount,
  };
};

export { createContainerLayoutReport };
