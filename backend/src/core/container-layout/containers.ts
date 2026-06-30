import { areaOf } from "../geometry.js";

import type { ContainerRecord } from "./types.js";

export {
  createAssignments,
  mergeOverlappingShellAssignments,
  resolveParentContainerId,
} from "./assignments.js";
export {
  buildExplicitContainers,
  getSmallestContainingShape,
} from "./candidates.js";
export { inferMemberAlignments } from "./alignments.js";

export const resolveEntryChildren = ({
  containers,
  rootChildren,
}: {
  containers: ContainerRecord[];
  rootChildren: string[];
}) => {
  // Collapse wrapper-only explicit groups, but keep meaningful grouping when
  // siblings mix explicit containers with inferred shape containers.
  const byId = new Map(
    containers.map((container) => [container.id, container] as const),
  );
  let current = [...rootChildren];

  while (current.length === 1) {
    const onlyChild = byId.get(current[0] ?? "");
    if (!onlyChild) break;
    if (onlyChild.kind !== "explicit-group") break;
    if (onlyChild.childContainerIds.length < 2) break;
    if (onlyChild.directMemberNodePaths.length > 0) break;
    current = onlyChild.childContainerIds;
  }

  const siblings = current
    .map((containerId) => byId.get(containerId))
    .filter((container): container is ContainerRecord => Boolean(container));

  if (!siblings.length) return current;

  const firstSibling = siblings[0];
  if (!firstSibling) return current;
  const sharedParent = byId.get(firstSibling.parentContainerId ?? "");
  const parentArea = areaOf(sharedParent?.box ?? firstSibling.box);
  const structuralShapeChildren = siblings.filter((container) => {
    if (container.kind !== "shape-container") return false;
    if (
      container.childContainerIds.length === 0 &&
      container.directMemberNodePaths.length === 0 &&
      areaOf(container.box) >= parentArea * 0.55
    ) {
      return false;
    }
    if (container.childContainerIds.length >= 1) return true;
    if (
      container.directMemberNodePaths.length >= 3 &&
      areaOf(container.box) >= parentArea * 0.012
    ) {
      return true;
    }
    return (
      container.directMemberNodePaths.length >= 1 &&
      container.box.width >= 160 &&
      container.box.height >= 72 &&
      areaOf(container.box) <= parentArea * 0.55
    );
  });

  const explicitChildren = siblings.filter(
    (container) => container.kind === "explicit-group",
  );
  if (explicitChildren.length) {
    const structuralIds = new Set(
      structuralShapeChildren.map((container) => container.id),
    );
    return siblings
      .filter(
        (container) =>
          container.kind === "explicit-group" ||
          structuralIds.has(container.id),
      )
      .map((container) => container.id);
  }

  return structuralShapeChildren.length
    ? structuralShapeChildren.map((container) => container.id)
    : current;
};
