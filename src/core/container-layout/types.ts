import type { Box } from "../utils.js";

export type ContainerKind = "explicit-group" | "root" | "shape-container";

export type ContainerRecord = {
  box: Box;
  childContainerIds: string[];
  depth: number;
  descendantCount: number;
  directMemberNodePaths: string[];
  id: string;
  kind: ContainerKind;
  nodePath: string;
  parentContainerId: null | string;
  reasons: string[];
  score: number;
  tag: string;
};

export type AssignmentRecord = {
  assignedContainerId: string;
  nodePath: string;
  reason: string;
  score: number;
};

export type RepeatedGroupRecord = {
  alignment: "column" | "row";
  containerIds: string[];
  gapPx: number;
  parentContainerId: string;
  signature: string;
};

export type PatternHint = {
  containerIds: string[];
  kind: "cell-row" | "repeat-group" | "shell-candidate";
  recipeId: string;
  summary: string;
};

export type RebuildRecipe = {
  applyWhen: string;
  forbiddenStructure: string[];
  id: string;
  kind: PatternHint["kind"];
  preferredStructure: string[];
  targets: Array<{
    box: Box;
    containerId: string;
  }>;
  title: string;
  validationFocus: string[];
};

export type MemberAlignmentHint = {
  /** Horizontal alignment relative to the container */
  alignX: "center" | "left" | "right";
  /** Distance from the container's right edge to the member's right edge (px) */
  rightGap: number;
  /** Distance from the container's left edge to the member's left edge (px) */
  leftGap: number;
  /** The SVG node path of this member */
  nodePath: string;
  /** The bounding box of this member */
  box: Box;
};

export type ContainerMemberAlignments = {
  containerId: string;
  members: MemberAlignmentHint[];
};

export type ContainerLayoutReport = {
  assignments: AssignmentRecord[];
  containers: ContainerRecord[];
  entryChildren: string[];
  memberAlignments: ContainerMemberAlignments[];
  nodeCount: number;
  patterns: PatternHint[];
  recipes: RebuildRecipe[];
  repeatedGroups: RepeatedGroupRecord[];
  rootChildren: string[];
  svgPath: string;
  unassignedNodePaths: string[];
};

export type ExplicitContainerMeta = {
  box: Box;
  depth: number;
  descendantCount: number;
  kind: Extract<ContainerKind, "explicit-group" | "root">;
  nodePath: string;
  parentPath: null | string;
  reasons: string[];
  score: number;
  tag: string;
};

export type ShapeContainerMeta = {
  box: Box;
  depth: number;
  kind: "shape-container";
  nodePath: string;
  parentPath: null | string;
  reasons: string[];
  score: number;
  tag: string;
};
