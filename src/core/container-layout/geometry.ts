export {
  areaOf,
  bottomOf,
  centerXOf,
  centerYOf,
  containmentRatio,
  overlapRatio,
  rightOf,
} from "../geometry.js";

export const isAncestorPath = (maybeAncestor: string, nodePath: string) =>
  nodePath.startsWith(`${maybeAncestor} > `);

export const isResourceNodePath = (nodePath: string) =>
  /(^| > )(defs|clipPath|mask|pattern|symbol):nth-of-type\(\d+\)/.test(
    nodePath,
  );

export const isSimilar = (left: number, right: number, tolerance = 0.12) => {
  const larger = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / larger <= tolerance;
};
