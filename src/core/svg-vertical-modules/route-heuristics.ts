import type { ContainerLayoutReport } from "../container-layout/types.js";
import type { Box } from "../utils.js";

const SMALL_DESIGN_MAX_NODE_COUNT = 100;

export const isSmallLowComplexityDesign = (input: {
  containerLayout?: ContainerLayoutReport;
  svgNodeCount?: number;
  viewport: Box;
}) => {
  const nodeCount = input.svgNodeCount ?? input.containerLayout?.nodeCount ?? 0;
  const aspectRatio = input.viewport.height / Math.max(1, input.viewport.width);
  if (input.viewport.height > 1600 || aspectRatio >= 2.2) return false;
  return nodeCount <= SMALL_DESIGN_MAX_NODE_COUNT;
};
