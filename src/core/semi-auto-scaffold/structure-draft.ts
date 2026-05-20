import path from "node:path";

import {
  type ContainerLayoutReport,
  type ContainerRecord,
  type PatternHint,
  type RepeatedGroupRecord,
} from "../container-layout/types.js";
import type { TextLayoutBlock } from "../text-layout.js";
import type { Box } from "../utils.js";
import type {
  OcrBlockRecord,
  ShellManifestEntry,
  StructureDraft,
  StructureDraftNode,
} from "./types.js";
import {
  areaOf,
  boxCenterDistance,
  containmentRatio,
  sanitizeId,
} from "./utils.js";

const pruneEmptyDraftNodes = ({
  rootNodeIds,
  nodeById,
}: {
  rootNodeIds: string[];
  nodeById: Map<string, StructureDraftNode>;
}) => {
  const shouldKeep = (node: StructureDraftNode) => {
    if (node.role === "shell") return true;
    if (node.role === "container") return true;
    if (node.role === "repeat-list" || node.role === "repeat-item") return true;
    if (node.role === "token-row" || node.role === "token-cell") return true;
    if (node.textBlockIds.length > 0) return true;
    if (node.children.length > 0) return true;
    if (node.shellEntryId) return true;
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
  ocrBlocks,
  shellManifest,
}: {
  containerLayout: ContainerLayoutReport;
  ocrBlocks: OcrBlockRecord[];
  shellManifest: ShellManifestEntry[];
}) => {
  const containerById = new Map(
    containerLayout.containers.map(
      (container) => [container.id, container] as const,
    ),
  );
  const shellByContainerId = new Map(
    shellManifest.map((entry) => [entry.containerId, entry] as const),
  );
  const nodeById = new Map<string, StructureDraftNode>();
  const rootNodeIds: string[] = [];
  const textCapableNodeIds: string[] = [];

  const registerNode = (node: StructureDraftNode) => {
    nodeById.set(node.id, node);
    if (node.role !== "shell") textCapableNodeIds.push(node.id);
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
        shellEntryId: null,
        tag: "section",
        textBlockIds: [],
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
          shellEntryId:
            shellByContainerId.get(container.id)?.containerId ?? null,
          tag: isTokenRow ? "div" : "article",
          textBlockIds: [],
        });

      if (!isTokenRow) {
        const shellEntry = shellByContainerId.get(container.id);
        if (shellEntry) {
          const shellNodeId = `node-shell-${sanitizeId(container.id)}`;
          const shellNode =
            nodeById.get(shellNodeId) ??
            registerNode({
              box: {
                height: container.box.height,
                width: container.box.width,
                x: container.box.x,
                y: container.box.y,
              },
              children: [],
              containerId: container.id,
              id: shellNodeId,
              patternKinds: ["shell-candidate"],
              repeatGroupId: groupNode.repeatGroupId,
              role: "shell",
              selector: `#${shellNodeId}`,
              shellEntryId: shellEntry.containerId,
              tag: "div",
              textBlockIds: [],
            });
          if (!itemNode.children.includes(shellNode.id))
            itemNode.children.push(shellNode.id);
        }
      }

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
        shellEntryId: shellByContainerId.get(container.id)?.containerId ?? null,
        tag: topLevel ? "section" : "div",
        textBlockIds: [],
      });

    if (topLevel && !rootNodeIds.includes(node.id)) rootNodeIds.push(node.id);
    if (parentNode && !parentNode.children.includes(node.id))
      parentNode.children.push(node.id);

    const shellEntry = shellByContainerId.get(container.id);
    if (shellEntry) {
      const shellNodeId = `node-shell-${sanitizeId(container.id)}`;
      const shellNode =
        nodeById.get(shellNodeId) ??
        registerNode({
          box: container.box,
          children: [],
          containerId: container.id,
          id: shellNodeId,
          patternKinds: ["shell-candidate"],
          repeatGroupId: null,
          role: "shell",
          selector: `#${shellNodeId}`,
          shellEntryId: shellEntry.containerId,
          tag: "div",
          textBlockIds: [],
        });
      if (!node.children.includes(shellNode.id))
        node.children.push(shellNode.id);
    }

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
      shellByContainerId.has(rootContainerId) ||
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

  const textCapableNodes = textCapableNodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is StructureDraftNode => Boolean(node));

  ocrBlocks.forEach((block) => {
    const candidates = textCapableNodes
      .filter((node) => containmentRatio(block.bbox, node.box) >= 0.7)
      .sort((left, right) => areaOf(left.box) - areaOf(right.box));

    let bestNode = candidates[0];

    if (!bestNode) {
      const nearest = [...textCapableNodes].sort(
        (left, right) =>
          boxCenterDistance(block.bbox, left.box) -
          boxCenterDistance(block.bbox, right.box),
      )[0];

      if (nearest) {
        const parentNode = [...nodeById.values()].find((node) =>
          node.children.includes(nearest.id),
        );
        bestNode =
          parentNode && containmentRatio(block.bbox, parentNode.box) >= 0.5
            ? parentNode
            : nearest;
      }
    }

    if (!bestNode) return;

    block.assignedNodeId = bestNode.id;
    bestNode.textBlockIds.push(block.id);
  });

  const trackedBlocks: TextLayoutBlock[] = ocrBlocks
    .filter((block) => block.assignedNodeId)
    .map((block) => ({
      declarations: {},
      id: block.id,
      region: block.bbox,
      selectors: [`#text-${sanitizeId(block.id)}`],
    }));

  const prunedRootNodeIds = pruneEmptyDraftNodes({
    rootNodeIds,
    nodeById,
  });

  return {
    designName: path.basename(containerLayout.svgPath, ".svg"),
    nodes: [...nodeById.values()],
    ocrBlockIds: ocrBlocks.map((block) => block.id),
    pageSelector: ".design-page",
    topLevelNodeIds: prunedRootNodeIds,
    trackedBlocks,
  } satisfies StructureDraft;
};

export { buildStructureDraft };
