const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export { isRecord };

// Compatibility re-exports for existing consumers.
export type { Box, Region } from "./geometry.js";
export type { ResolvedDesignTarget, ResolvedSvgDesign } from "./design-resolve.js";
export type { RootChildElement } from "./html-parse.js";
export {
  getWorkspaceRoot,
  isInsidePath,
  resolveArtifactDir,
  setWorkspaceRoot,
  toAbsolutePath,
  toUrlPath,
} from "./paths.js";
export { ensureSvgViewBox, parseSvgSize, readSvgDimensions } from "./svg-parse.js";
export {
  resolveDesignTarget,
  resolveRenderTarget,
  resolveSvgDesign,
} from "./design-resolve.js";
export { findTagEnd, parseRootChildElements } from "./html-parse.js";
export { assertFile, writeJsonFile, writeTextFile } from "./file-io.js";
