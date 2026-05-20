import type { Box } from "../utils.js";
import type {
  PlannerOcrBlock,
  PlannerShellEntry,
  SvgVerticalModule,
} from "./types.js";
import { toSerializableRegion, uniqueStrings } from "./geometry.js";

export const createFallbackModule = ({
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
    ocrBlockIds: [],
    reason,
    region,
    score: 0,
    shellContainerIds: [],
    sourceContainerIds: [],
  };
};

export const createSinglePageModule = ({
  candidateNodeCount = 0,
  ocrBlocks,
  reason,
  shellManifest,
  viewport,
}: {
  candidateNodeCount?: number;
  ocrBlocks: PlannerOcrBlock[];
  reason: string;
  shellManifest: PlannerShellEntry[];
  viewport: Box;
}) => ({
  ...createFallbackModule({
    reason,
    viewport,
  }),
  candidateNodeCount,
  ocrBlockIds: uniqueStrings(ocrBlocks.map((block) => block.id)),
  shellContainerIds: uniqueStrings(
    shellManifest.map((entry) => entry.containerId),
  ),
});
