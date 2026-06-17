import type { Box } from "../utils.js";
import type {
  SvgVerticalModule,
} from "./types.js";
import { toSerializableRegion } from "./geometry.js";

const createFallbackModule = ({
  id = "module-01",
  reason,
  viewport,
}: {
  id?: string;
  reason: string;
  viewport: Box;
}): SvgVerticalModule => {
  const region = toSerializableRegion(id, viewport);
  return {
    candidateNodeCount: 0,
    contentBox: {
      height: viewport.height,
      width: viewport.width,
      x: viewport.x,
      y: viewport.y,
    },
    diffRegion: region,
    id,
    kind: "single-page",
    nodePaths: [],
    reason,
    region,
    score: 0,
    sourceContainerIds: [],
  };
};

export const createSinglePageModule = ({
  candidateNodeCount = 0,
  reason,
  viewport,
}: {
  candidateNodeCount?: number;
  reason: string;
  viewport: Box;
}) => ({
  ...createFallbackModule({
    reason,
    viewport,
  }),
  candidateNodeCount,
});
