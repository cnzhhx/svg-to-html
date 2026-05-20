import type { SvgLayoutNode } from "../svg-layout.js";
import type {
  ContainerMemberAlignments,
  ContainerRecord,
  MemberAlignmentHint,
} from "./types.js";

export const inferMemberAlignments = ({
  containers,
  svgNodes,
}: {
  containers: ContainerRecord[];
  svgNodes: SvgLayoutNode[];
}): ContainerMemberAlignments[] => {
  const nodesByPath = new Map(
    svgNodes.map((node) => [node.nodePath, node] as const),
  );
  const results: ContainerMemberAlignments[] = [];

  containers.forEach((container) => {
    if (container.kind === "root") return;
    if (container.directMemberNodePaths.length === 0) return;

    const members: MemberAlignmentHint[] = [];

    container.directMemberNodePaths.forEach((nodePath) => {
      const node = nodesByPath.get(nodePath);
      if (!node?.pixelBox) return;

      const memberBox = node.pixelBox;
      const leftGap = Number((memberBox.x - container.box.x).toFixed(3));
      const rightGap = Number(
        (
          container.box.x +
          container.box.width -
          (memberBox.x + memberBox.width)
        ).toFixed(3),
      );

      let alignX: MemberAlignmentHint["alignX"] = "left";

      // Determine alignment heuristic:
      // - If rightGap is much smaller than leftGap -> right-aligned
      // - If leftGap is much smaller than rightGap -> left-aligned
      // - If both gaps are roughly equal (center within tolerance) -> center-aligned
      const containerWidth = container.box.width;
      const centerTolerance = containerWidth * 0.05;
      const memberCenterX = memberBox.x + memberBox.width / 2;
      const containerCenterX = container.box.x + containerWidth / 2;

      if (Math.abs(memberCenterX - containerCenterX) <= centerTolerance) {
        alignX = "center";
      } else if (rightGap < leftGap * 0.4 && rightGap < containerWidth * 0.15) {
        alignX = "right";
      } else {
        alignX = "left";
      }

      members.push({
        alignX,
        box: memberBox,
        leftGap,
        nodePath,
        rightGap,
      });
    });

    if (members.length > 0) {
      results.push({
        containerId: container.id,
        members,
      });
    }
  });

  return results;
};
