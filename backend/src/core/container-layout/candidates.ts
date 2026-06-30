import type { SvgLayoutNode } from "../svg-layout.js";
import type { Box } from "../geometry.js";
import {
  areaOf,
  centerXOf,
  centerYOf,
  containmentRatio,
  overlapRatio,
} from "../geometry.js";
import { isAncestorPath, isSimilar } from "./patterns.js";
import type { ExplicitContainerMeta, ShapeContainerMeta } from "./types.js";

const SHAPE_CONTAINER_TAGS = new Set([
  "circle",
  "ellipse",
  "image",
  "path",
  "rect",
  "use",
]);

const getDescendantCount = (
  nodePath: string,
  nodesWithBoxes: SvgLayoutNode[],
) =>
  nodesWithBoxes.filter((candidate) =>
    isAncestorPath(nodePath, candidate.nodePath),
  ).length;

export const isShellLayerPeer = (peerBox: Box, candidateBox: Box) =>
  overlapRatio(peerBox, candidateBox) >= 0.96 &&
  isSimilar(peerBox.width, candidateBox.width, 0.03) &&
  isSimilar(peerBox.height, candidateBox.height, 0.03);

const isCenteredLabelPeer = (peerBox: Box, candidateBox: Box) => {
  const widthRatio = peerBox.width / Math.max(1, candidateBox.width);
  const heightRatio = peerBox.height / Math.max(1, candidateBox.height);
  const centerDeltaX = Math.abs(centerXOf(peerBox) - centerXOf(candidateBox));
  const centerDeltaY = Math.abs(centerYOf(peerBox) - centerYOf(candidateBox));

  return (
    widthRatio >= 0.12 &&
    widthRatio <= 0.72 &&
    heightRatio >= 0.16 &&
    heightRatio <= 0.72 &&
    centerDeltaX <= Math.max(12, candidateBox.width * 0.22) &&
    centerDeltaY <= Math.max(8, candidateBox.height * 0.18)
  );
};

const hasPatternFill = (node: SvgLayoutNode) =>
  typeof node.attributes.fill === "string" &&
  /url\(#pattern/i.test(node.attributes.fill);

const isMediaLikePeer = (node: SvgLayoutNode) => {
  if (node.tag === "image" || node.tag === "use") return true;
  if (node.tag === "rect" && hasPatternFill(node)) return true;
  return false;
};

export const buildExplicitContainers = (nodesWithBoxes: SvgLayoutNode[]) =>
  nodesWithBoxes
    .filter((node) => node.tag === "svg" || node.tag === "g")
    .map<ExplicitContainerMeta>((node) => {
      const box = node.pixelBox as Box;
      const descendantCount = getDescendantCount(node.nodePath, nodesWithBoxes);
      const isRoot = node.tag === "svg";
      return {
        box,
        depth: node.depth,
        descendantCount,
        kind: isRoot ? "root" : "explicit-group",
        nodePath: node.nodePath,
        parentPath: node.parentPath,
        reasons: [
          isRoot ? "svg root" : "svg group",
          `descendants with boxes: ${descendantCount}`,
        ],
        score: isRoot
          ? 100
          : Number((55 + Math.min(40, descendantCount * 2)).toFixed(2)),
        tag: node.tag,
      };
    })
    .filter(
      (container) =>
        container.kind === "root" || container.descendantCount >= 2,
    );

export const getSmallestContainingShape = (
  node: SvgLayoutNode,
  nodesByParent: Map<string, SvgLayoutNode[]>,
): null | ShapeContainerMeta => {
  // Prefer the tightest sibling shape around a node; large page backgrounds
  // should not become the direct semantic container for every child.
  const nodeBox = node.pixelBox;
  const { parentPath } = node;

  if (!nodeBox || !parentPath) return null;
  const siblings = nodesByParent.get(parentPath) ?? [];
  const candidates = siblings
    .filter((candidate) => {
      const candidateBox = candidate.pixelBox;
      if (!candidateBox || candidate.nodePath === node.nodePath) return false;
      if (!SHAPE_CONTAINER_TAGS.has(candidate.tag)) return false;
      if (areaOf(candidateBox) <= areaOf(nodeBox)) return false;
      if (containmentRatio(nodeBox, candidateBox) < 0.94) return false;
      return true;
    })
    .map((candidate) => {
      const candidateBox = candidate.pixelBox as Box;
      const peerHits = siblings
        .filter((peer) => {
          const peerBox = peer.pixelBox;
          if (!peerBox || peer.nodePath === candidate.nodePath) return false;
          return (
            containmentRatio(peerBox, candidateBox) >= 0.9 ||
            overlapRatio(peerBox, candidateBox) >= 0.96
          );
        })
        .map((peer) => {
          const peerBox = peer.pixelBox as Box;
          const shellLayer = isShellLayerPeer(peerBox, candidateBox);
          const centeredLabel =
            !shellLayer && isCenteredLabelPeer(peerBox, candidateBox);
          return {
            centeredLabel,
            peer,
            peerBox,
            shellLayer,
          };
        });
      const containedPeers = peerHits.filter(
        ({ peerBox, shellLayer }) =>
          !shellLayer && areaOf(peerBox) < areaOf(candidateBox) * 0.98,
      );
      const shellLayerPeers = peerHits.filter(({ shellLayer }) => shellLayer);
      const centeredLabelPeers = containedPeers.filter(
        ({ centeredLabel }) => centeredLabel,
      );
      const mediaPeers = containedPeers.filter(({ peer }) =>
        isMediaLikePeer(peer),
      );
      const nonMediaContainedPeers = containedPeers.filter(
        ({ peer }) => !isMediaLikePeer(peer),
      );
      const qualifiesAsButtonShell =
        shellLayerPeers.length >= 1 && centeredLabelPeers.length >= 1;
      const qualifiesAsContentContainer = containedPeers.length >= 2;
      const qualifiesAsMediaContainer =
        shellLayerPeers.length >= 1 &&
        mediaPeers.length >= 1 &&
        nonMediaContainedPeers.length === 0 &&
        candidateBox.width >= 96 &&
        candidateBox.height >= 96;

      return {
        candidate,
        candidateBox,
        containedPeers,
        qualifiesAsButtonShell,
        qualifiesAsContentContainer,
        qualifiesAsMediaContainer,
        mediaPeers,
        shellLayerPeers,
      };
    })
    .filter(
      ({
        candidateBox,
        qualifiesAsButtonShell,
        qualifiesAsContentContainer,
        qualifiesAsMediaContainer,
      }) => {
        if (candidateBox.width < 24 || candidateBox.height < 24) return false;
        return (
          qualifiesAsContentContainer ||
          qualifiesAsButtonShell ||
          qualifiesAsMediaContainer
        );
      },
    )
    .sort(
      (left, right) => areaOf(left.candidateBox) - areaOf(right.candidateBox),
    );

  const hit = candidates[0];
  if (!hit) return null;

  const reasons: string[] = [];
  if (hit.qualifiesAsButtonShell) {
    reasons.push("overlapping shell layers + centered single label");
    reasons.push(`shell layers: ${hit.shellLayerPeers.length}`);
  }
  if (hit.qualifiesAsContentContainer) {
    reasons.push("contains multiple sibling nodes by bbox");
    reasons.push(`contained peers: ${hit.containedPeers.length}`);
  }
  if (hit.qualifiesAsMediaContainer) {
    reasons.push("overlapping media shell layers + single media child");
    reasons.push(`media peers: ${hit.mediaPeers.length}`);
  }

  return {
    box: hit.candidateBox,
    depth: hit.candidate.depth,
    kind: "shape-container",
    nodePath: hit.candidate.nodePath,
    parentPath: hit.candidate.parentPath,
    reasons,
    score: Number(
      (
        70 +
        hit.containedPeers.length * 8 +
        hit.shellLayerPeers.length * 6 +
        hit.mediaPeers.length * 4
      ).toFixed(2),
    ),
    tag: hit.candidate.tag,
  };
};
