import type {
  OcrBlocksInput,
  PlannerOcrBlock,
  PlannerShellEntry,
  ShellManifestInput,
} from "./types.js";
import { isFiniteBox } from "./geometry.js";

export const normalizeOcrBlocks = (
  input?: OcrBlocksInput,
): PlannerOcrBlock[] => {
  const blocks = Array.isArray(input) ? input : (input?.blocks ?? []);
  return blocks.filter(
    (block) => block.id && block.bbox && isFiniteBox(block.bbox),
  );
};

export const normalizeShellManifest = (
  input?: ShellManifestInput,
): PlannerShellEntry[] => {
  const entries = Array.isArray(input) ? input : (input?.entries ?? []);
  return entries.filter((entry) => entry.containerId);
};
