import type { ContainerLayoutReport, ContainerRecord } from "./types.js";

const renderContainerTree = ({
  containerById,
  containerId,
  depth,
}: {
  containerById: Map<string, ContainerRecord>;
  containerId: string;
  depth: number;
}): string[] => {
  const container = containerById.get(containerId);
  if (!container) return [];

  const indent = "  ".repeat(depth);
  const reason = container.reasons[0] ?? "n/a";
  const lines = [
    `${indent}- ${container.id} | ${container.kind} | ${container.tag} | box=(${container.box.x}, ${container.box.y}, ${container.box.width}x${container.box.height}) | children=${container.childContainerIds.length} | members=${container.directMemberNodePaths.length} | ${reason}`,
  ];

  container.childContainerIds.forEach((childId) => {
    lines.push(
      ...renderContainerTree({
        containerById,
        containerId: childId,
        depth: depth + 1,
      }),
    );
  });

  return lines;
};

export const createReport = (output: ContainerLayoutReport) => {
  const containerById = new Map(
    output.containers.map((container) => [container.id, container] as const),
  );
  const rootContainer = output.containers.find(
    (container) => container.kind === "root",
  );

  const lines = [
    "# Container Layout Report",
    "",
    `- SVG: ${output.svgPath}`,
    `- Nodes with boxes: ${output.nodeCount}`,
    `- Containers: ${output.containers.length}`,
    `- Assignments: ${output.assignments.length}`,
    `- Repeated groups: ${output.repeatedGroups.length}`,
    `- Pattern hints: ${output.patterns.length}`,
    "",
    "## Root Children",
  ];

  if (!output.rootChildren.length) lines.push("- none");
  output.rootChildren.forEach((containerId) => {
    const container = containerById.get(containerId);
    if (!container) return;
    lines.push(
      `- ${container.id} | ${container.kind} | ${container.tag} | (${container.box.x}, ${container.box.y}, ${container.box.width}, ${container.box.height}) | children=${container.childContainerIds.length} | members=${container.directMemberNodePaths.length}`,
    );
  });

  lines.push("", "## Entry Children");
  if (!output.entryChildren.length) lines.push("- none");
  output.entryChildren.forEach((containerId) => {
    const container = containerById.get(containerId);
    if (!container) return;
    lines.push(
      `- ${container.id} | ${container.kind} | ${container.tag} | (${container.box.x}, ${container.box.y}, ${container.box.width}, ${container.box.height}) | children=${container.childContainerIds.length} | members=${container.directMemberNodePaths.length}`,
    );
  });

  lines.push("", "## Repeated Groups");

  if (!output.repeatedGroups.length) lines.push("- none");
  else {
    output.repeatedGroups.forEach((group) => {
      lines.push(
        `- ${group.parentContainerId} | ${group.alignment} | gap ${group.gapPx}px | ${group.containerIds.join(", ")}`,
      );
    });
  }

  lines.push("", "## Pattern Hints");
  if (!output.patterns.length) lines.push("- none");
  else {
    output.patterns.forEach((pattern) => {
      lines.push(
        `- [${pattern.kind}] ${pattern.summary} containers=${pattern.containerIds.join(", ")} recipe=${pattern.recipeId}`,
      );
    });
  }

  lines.push("", "## Rebuild Recipes");
  if (!output.recipes.length) {
    lines.push("- none");
  } else {
    output.recipes.forEach((recipe) => {
      lines.push(
        `### ${recipe.title}`,
        `- id: ${recipe.id}`,
        `- kind: ${recipe.kind}`,
        `- applyWhen: ${recipe.applyWhen}`,
        `- targets: ${recipe.targets.map((target) => `${target.containerId}(${target.box.x},${target.box.y},${target.box.width}x${target.box.height})`).join("; ")}`,
        "- preferredStructure:",
        ...recipe.preferredStructure.map((item) => `  - ${item}`),
        "- forbiddenStructure:",
        ...recipe.forbiddenStructure.map((item) => `  - ${item}`),
        "- validationFocus:",
        ...recipe.validationFocus.map((item) => `  - ${item}`),
        "",
      );
    });
  }

  lines.push("## Container Tree");
  if (rootContainer) {
    lines.push(
      ...renderContainerTree({
        containerById,
        containerId: rootContainer.id,
        depth: 0,
      }),
    );
  } else {
    lines.push("- none");
  }

  lines.push("", "## Unassigned Nodes");
  lines.push(
    output.unassignedNodePaths.length
      ? `- ${output.unassignedNodePaths.join(", ")}`
      : "- none",
  );

  // Member alignment hints — tells the LLM how each member is positioned within its container
  const hasNonLeftAlignments = (output.memberAlignments ?? []).some((item) =>
    item.members.some((member) => member.alignX !== "left"),
  );

  if (hasNonLeftAlignments) {
    lines.push("", "## Member Alignment Hints");
    lines.push(
      "> 以下标注了容器内子节点的水平对齐方式。LLM 重写 HTML 时，right-aligned 元素应使用 `right: <rightGap>px` 定位而非 `left`；center-aligned 应使用居中方式。",
      "",
    );
    (output.memberAlignments ?? []).forEach((item) => {
      const nonLeftMembers = item.members.filter(
        (member) => member.alignX !== "left",
      );
      if (nonLeftMembers.length === 0) return;

      const container = containerById.get(item.containerId);
      if (!container) return;

      lines.push(
        `### ${item.containerId} (${container.kind}, ${container.box.width}x${container.box.height})`,
      );
      item.members.forEach((member) => {
        const alignLabel =
          member.alignX === "right"
            ? `right-aligned, rightGap=${member.rightGap}px`
            : member.alignX === "center"
              ? `center-aligned`
              : `left-aligned, leftGap=${member.leftGap}px`;
        lines.push(
          `- \`${member.nodePath}\` [${alignLabel}] box=(${member.box.x},${member.box.y},${member.box.width}x${member.box.height})`,
        );
      });
      lines.push("");
    });
  }

  lines.push("", "## Containers", "");

  output.containers.forEach((container) => {
    lines.push(
      `### ${container.id} (${container.kind})`,
      `- tag: ${container.tag}`,
      `- nodePath: \`${container.nodePath}\``,
      `- box: ${container.box.x}, ${container.box.y}, ${container.box.width}x${container.box.height}`,
      `- depth: ${container.depth}`,
      `- parent: ${container.parentContainerId ?? "none"}`,
      `- children: ${container.childContainerIds.join(", ") || "none"}`,
      `- directMembers: ${container.directMemberNodePaths.length}`,
      `- reasons: ${container.reasons.join("; ")}`,
      "",
    );
  });

  return `${lines.join("\n")}\n`;
};
