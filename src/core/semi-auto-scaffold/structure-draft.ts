import path from "node:path";

import {
  type ContainerLayoutReport,
  type ContainerRecord,
  type PatternHint,
  type RepeatedGroupRecord,
} from "../container-layout/types.js";
import type { Box } from "../utils.js";
import type {
  StructureDraft,
  StructureDraftNode,
} from "./types.js";
import { sanitizeId } from "./utils.js";

const pruneEmptyDraftNodes = ({
  rootNodeIds,
  nodeById,
}: {
  rootNodeIds: string[];
  nodeById: Map<string, StructureDraftNode>;
}) => {
  const shouldKeep = (node: StructureDraftNode) => {
    if (node.role === "container") return true;
    if (node.role === "repeat-list" || node.role === "repeat-item") return true;
    if (node.role === "token-row" || node.role === "token-cell") return true;
    if (node.children.length > 0) return true;
    return false;
  };

  const pruneNode = (nodeId: string): boolean => {
    const node = nodeById.get(nodeId);
    if (!node) return false;

    const keptChildren = node.children.filter((childId) => pruneNode(childId));
    node.children = keptChildren;

    if (!shouldKeep(node)) {
      nodeById.delete(nodeId);
      return false;
    }

    return true;
  };

  return rootNodeIds.filter((nodeId) => pruneNode(nodeId));
};

const collectPatternKinds = ({
  containerId,
  patterns,
}: {
  containerId: string;
  patterns: PatternHint[];
}) =>
  patterns
    .filter((pattern) => pattern.containerIds.includes(containerId))
    .map((pattern) => pattern.kind);

const buildTokenRowBox = ({
  containers,
  containerIds,
}: {
  containers: Map<string, ContainerRecord>;
  containerIds: string[];
}) => {
  const boxes = containerIds
    .map((containerId) => containers.get(containerId)?.box)
    .filter((box): box is Box => Boolean(box));

  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    height: Number((maxY - minY).toFixed(3)),
    width: Number((maxX - minX).toFixed(3)),
    x: Number(minX.toFixed(3)),
    y: Number(minY.toFixed(3)),
  } satisfies Box;
};

const buildStructureDraft = ({
  containerLayout,
}: {
  containerLayout: ContainerLayoutReport;
}) => {
  const containerById = new Map(
    containerLayout.containers.map(
      (container) => [container.id, container] as const,
    ),
  );
  const nodeById = new Map<string, StructureDraftNode>();
  const rootNodeIds: string[] = [];

  const registerNode = (node: StructureDraftNode) => {
    nodeById.set(node.id, node);
    return node;
  };

  const sortContainerIds = (containerIds: string[]) =>
    [...containerIds].sort((leftId, rightId) => {
      const leftBox = containerById.get(leftId)?.box;
      const rightBox = containerById.get(rightId)?.box;
      return (
        (leftBox?.y ?? 0) - (rightBox?.y ?? 0) ||
        (leftBox?.x ?? 0) - (rightBox?.x ?? 0)
      );
    });

  const shouldMaterializeContainer = (container: ContainerRecord) => {
    if (container.kind === "explicit-group" || container.kind === "root")
      return true;

    const patternKinds = collectPatternKinds({
      containerId: container.id,
      patterns: containerLayout.patterns,
    });

    return (
      patternKinds.length > 0 ||
      container.childContainerIds.length > 0 ||
      container.directMemberNodePaths.length >= 2
    );
  };

  const buildRepeatGroupNode = ({
    containers,
    group,
    parentNode,
    patterns,
  }: {
    containers: Map<string, ContainerRecord>;
    group: RepeatedGroupRecord;
    parentNode: StructureDraftNode;
    patterns: PatternHint[];
  }) => {
    const parentContainer = parentNode.containerId
      ? containers.get(parentNode.containerId)
      : null;
    const firstItem = containers.get(group.containerIds[0] ?? "");
    if (!parentContainer || !firstItem) {
      console.warn(
        `[semi-auto-scaffold] skipped repeat group: parent=${parentNode.containerId}, missing=${!parentContainer ? "parent" : "firstItem"}`,
      );
      return;
    }

    const isTokenRow = patterns.some(
      (pattern) =>
        pattern.kind === "cell-row" &&
        pattern.containerIds.length === group.containerIds.length &&
        pattern.containerIds.every((containerId) =>
          group.containerIds.includes(containerId),
        ),
    );

    const groupNodeId = isTokenRow
      ? `node-token-row-${sanitizeId(group.containerIds.join("-"))}`
      : `node-repeat-group-${sanitizeId(group.containerIds.join("-"))}`;

    const existingGroupNode = nodeById.get(groupNodeId);
    const groupNode =
      existingGroupNode ??
      registerNode({
        box: isTokenRow
          ? buildTokenRowBox({
              containers,
              containerIds: group.containerIds,
            })
          : {
              height: firstItem.box.height,
              width:
                group.alignment === "row"
                  ? Number(
                      (
                        group.containerIds.reduce((sum, containerId) => {
                          const box = containers.get(containerId)?.box;
                          return sum + (box?.width ?? 0);
                        }, 0) +
                        group.gapPx * Math.max(0, group.containerIds.length - 1)
                      ).toFixed(3),
                    )
                  : firstItem.box.width,
              x: firstItem.box.x,
              y: firstItem.box.y,
            },
        children: [],
        containerId: parentContainer.id,
        id: groupNodeId,
        patternKinds: isTokenRow ? ["cell-row"] : ["repeat-group"],
        repeatGroupId: sanitizeId(group.containerIds.join("-")),
        role: isTokenRow ? "token-row" : "repeat-list",
        selector: `#${groupNodeId}`,
        tag: "section",
      });

    if (!parentNode.children.includes(groupNode.id))
      parentNode.children.push(groupNode.id);

    group.containerIds.forEach((containerId, index) => {
      const container = containers.get(containerId);
      if (!container) return;

      const nodeId = isTokenRow
        ? `node-token-cell-${sanitizeId(containerId)}`
        : `node-repeat-item-${sanitizeId(containerId)}`;

      const existingItemNode = nodeById.get(nodeId);
      const itemNode =
        existingItemNode ??
        registerNode({
          box: container.box,
          children: [],
          containerId: container.id,
          id: nodeId,
          patternKinds: collectPatternKinds({
            containerId: container.id,
            patterns,
          }),
          repeatGroupId: groupNode.repeatGroupId,
          role: isTokenRow ? "token-cell" : "repeat-item",
          selector: `#${nodeId}`,
          tag: isTokenRow ? "div" : "article",
        });

      if (!groupNode.children.includes(itemNode.id)) {
        groupNode.children.splice(index, 0, itemNode.id);
      }

      if (container.childContainerIds.length > 0) {
        sortContainerIds(container.childContainerIds).forEach(
          (childContainerId) => {
            buildContainerNode({
              containerId: childContainerId,
              parentNode: itemNode,
            });
          },
        );
      }
    });
  };

  const buildContainerNode = ({
    containerId,
    parentNode,
    topLevel = false,
  }: {
    containerId: string;
    parentNode?: StructureDraftNode;
    topLevel?: boolean;
  }): StructureDraftNode | null => {
    const container = containerById.get(containerId);
    if (!container || !shouldMaterializeContainer(container)) return null;

    const nodeId = `${topLevel ? "node-container" : "node-group"}-${sanitizeId(container.id)}`;
    const existingNode = nodeById.get(nodeId);
    const node =
      existingNode ??
      registerNode({
        box: container.box,
        children: [],
        containerId: container.id,
        id: nodeId,
        patternKinds: collectPatternKinds({
          containerId: container.id,
          patterns: containerLayout.patterns,
        }),
        repeatGroupId: null,
        role: topLevel ? "container" : "group",
        selector: `#${nodeId}`,
        tag: topLevel ? "section" : "div",
      });

    if (topLevel && !rootNodeIds.includes(node.id)) rootNodeIds.push(node.id);
    if (parentNode && !parentNode.children.includes(node.id))
      parentNode.children.push(node.id);

    const repeatedGroups = containerLayout.repeatedGroups
      .filter((group) => group.parentContainerId === container.id)
      .sort((left, right) => {
        const leftBox = containerById.get(left.containerIds[0] ?? "")?.box;
        const rightBox = containerById.get(right.containerIds[0] ?? "")?.box;
        return (
          (leftBox?.y ?? 0) - (rightBox?.y ?? 0) ||
          (leftBox?.x ?? 0) - (rightBox?.x ?? 0)
        );
      });

    const repeatedChildIds = new Set(
      repeatedGroups.flatMap((group) => group.containerIds),
    );
    repeatedGroups.forEach((group) => {
      buildRepeatGroupNode({
        containers: containerById,
        group,
        parentNode: node,
        patterns: containerLayout.patterns,
      });
    });

    sortContainerIds(container.childContainerIds)
      .filter((childContainerId) => !repeatedChildIds.has(childContainerId))
      .forEach((childContainerId) => {
        buildContainerNode({
          containerId: childContainerId,
          parentNode: node,
        });
      });

    return node;
  };

  const buildTopLevelNodes = () => {
    const rootContainer = containerLayout.containers.find(
      (container) => container.kind === "root",
    );
    const rootContainerId = rootContainer?.id ?? "root";
    const needsRootWrapper =
      containerLayout.repeatedGroups.some(
        (group) => group.parentContainerId === rootContainerId,
      );

    if (needsRootWrapper && rootContainer) {
      buildContainerNode({
        containerId: rootContainer.id,
        topLevel: true,
      });
      return;
    }

    const topLevelContainerIds =
      containerLayout.entryChildren.length > 0
        ? containerLayout.entryChildren
        : containerLayout.rootChildren;

    topLevelContainerIds.forEach((containerId) => {
      buildContainerNode({
        containerId,
        topLevel: true,
      });
    });
  };

  buildTopLevelNodes();

  const prunedRootNodeIds = pruneEmptyDraftNodes({
    rootNodeIds,
    nodeById,
  });

  return {
    designName: path.basename(containerLayout.svgPath, ".svg"),
    nodes: [...nodeById.values()],
    pageSelector: ".design-page",
    topLevelNodeIds: prunedRootNodeIds,
  } satisfies StructureDraft;
};

export { buildStructureDraft };
