import type { SvgLayoutNode } from "../svg-layout.js";
import {
  getSmallestContainingShape,
  isShellLayerPeer,
} from "./candidates.js";
import { areaOf } from "../geometry.js";
import type {
  AssignmentRecord,
  ContainerRecord,
  ExplicitContainerMeta,
  ShapeContainerMeta,
} from "./types.js";

export const createAssignments = ({
  containers,
  nodesByParent,
  rootContainerId,
  svgNodes,
}: {
  containers: ContainerRecord[];
  nodesByParent: Map<string, SvgLayoutNode[]>;
  rootContainerId: string;
  svgNodes: SvgLayoutNode[];
}) => {
  const containerByNodePath = new Map(
    containers.map((container) => [container.nodePath, container] as const),
  );
  const nodesByPath = new Map(
    svgNodes.map((node) => [node.nodePath, node] as const),
  );
  const assignments: AssignmentRecord[] = [];

  svgNodes.forEach((node) => {
    if (!node.pixelBox) return;
    const shapeContainer = getSmallestContainingShape(node, nodesByParent);

    if (shapeContainer) {
      const container = containerByNodePath.get(shapeContainer.nodePath);
      if (container) {
        assignments.push({
          assignedContainerId: container.id,
          nodePath: node.nodePath,
          reason: "contained by sibling shape container",
          score: shapeContainer.score,
        });
        return;
      }
    }

    let currentParentPath = node.parentPath;
    while (currentParentPath) {
      const parentContainer = containerByNodePath.get(currentParentPath);
      if (parentContainer) {
        const compactness = Number(
          (
            Math.min(
              1,
              areaOf(node.pixelBox) / Math.max(1, areaOf(parentContainer.box)),
            ) * 20
          ).toFixed(2),
        );
        assignments.push({
          assignedContainerId: parentContainer.id,
          nodePath: node.nodePath,
          reason: "nearest explicit svg ancestor",
          score: Number((parentContainer.score + compactness).toFixed(2)),
        });
        return;
      }
      currentParentPath =
        nodesByPath.get(currentParentPath)?.parentPath ?? null;
    }

    assignments.push({
      assignedContainerId: rootContainerId,
      nodePath: node.nodePath,
      reason: "fallback to root container",
      score: 0,
    });
  });

  return assignments;
};

export const mergeOverlappingShellAssignments = ({
  assignments,
  containers,
  nodesByParent,
  svgNodesByPath,
}: {
  assignments: AssignmentRecord[];
  containers: ContainerRecord[];
  nodesByParent: Map<string, SvgLayoutNode[]>;
  svgNodesByPath: Map<string, SvgLayoutNode>;
}) => {
  // Button-like shells often render as multiple overlapping layers. Merge those
  // layers into the centered label container so module planning sees one unit.
  containers
    .filter((container) =>
      container.reasons.includes(
        "overlapping shell layers + centered single label",
      ),
    )
    .forEach((container) => {
      const containerNode = svgNodesByPath.get(container.nodePath);
      const parentPath = containerNode?.parentPath;
      if (!parentPath) return;

      const siblings = nodesByParent.get(parentPath) ?? [];
      const shellPeers = siblings.filter((peer) => {
        if (!peer.pixelBox || peer.nodePath === container.nodePath)
          return false;
        return isShellLayerPeer(peer.pixelBox, container.box);
      });

      shellPeers.forEach((peer) => {
        const assignment = assignments.find(
          (item) => item.nodePath === peer.nodePath,
        );
        if (!assignment) return;
        assignment.assignedContainerId = container.id;
        assignment.reason =
          "merged overlapping shell layer into button container";
        assignment.score = Number((container.score + 1).toFixed(2));
      });
    });
};

export const resolveParentContainerId = ({
  container,
  containerByNodePath,
  rootContainerId,
  svgNodesByPath,
}: {
  container: ExplicitContainerMeta | ShapeContainerMeta;
  containerByNodePath: Map<string, ContainerRecord>;
  rootContainerId: string;
  svgNodesByPath: Map<string, SvgLayoutNode>;
}) => {
  let currentParentPath = container.parentPath;

  while (currentParentPath) {
    const parentContainer = containerByNodePath.get(currentParentPath);
    if (parentContainer && parentContainer.kind !== "shape-container") {
      return parentContainer.id;
    }
    currentParentPath =
      svgNodesByPath.get(currentParentPath)?.parentPath ?? null;
  }

  return rootContainerId;
};
