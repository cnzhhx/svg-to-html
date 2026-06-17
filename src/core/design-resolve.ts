import path from "node:path";

import type { OutputFormat, SessionOutputTarget } from "./output-target.js";
import { resolveOutputTarget } from "./output-target.js";
import { toAbsolutePath } from "./paths.js";
import { assertFile } from "./file-io.js";
import { parseSvgSize } from "./svg-parse.js";

const DEFAULT_SCALE = 1;

type ResolvedSvgDesign = {
  designName: string;
  width: number;
  height: number;
  scale: number;
  svgPath: string;
};

type ResolvedDesignTarget = ResolvedSvgDesign & {
  outputFormat: OutputFormat;
  outputTarget: SessionOutputTarget;
};

type ResolvedRenderTarget = ResolvedSvgDesign & {
  renderEntryPath: string;
};

const resolveSvgDesign = async (
  inputPath: string,
  options?: { scale?: number },
): Promise<ResolvedSvgDesign> => {
  const scale = options?.scale ?? DEFAULT_SCALE;
  const ext = path.extname(inputPath);
  const basePath = ext ? inputPath.slice(0, -ext.length) : inputPath;
  const svgPath = toAbsolutePath(`${basePath}.svg`);

  await assertFile(svgPath, "SVG");
  const { width, height } = await parseSvgSize(svgPath, scale);

  return {
    svgPath,
    designName: path.basename(basePath),
    scale,
    width,
    height,
  };
};

const resolveDesignTarget = async (
  inputPath: string,
  options: { format: OutputFormat; scale?: number },
): Promise<ResolvedDesignTarget> => {
  const design = await resolveSvgDesign(inputPath, options);
  return {
    ...design,
    outputFormat: options.format,
    outputTarget: resolveOutputTarget({
      format: options.format,
      svgPath: design.svgPath,
    }),
  };
};

const resolveRenderTarget = async (
  inputPath: string,
  options: { renderEntryPath: string; scale?: number },
): Promise<ResolvedRenderTarget> => {
  const design = await resolveSvgDesign(inputPath, options);
  const renderEntryPath = toAbsolutePath(options.renderEntryPath);
  await assertFile(renderEntryPath, "Render entry");
  return {
    ...design,
    renderEntryPath,
  };
};

export type {
  ResolvedDesignTarget,
  ResolvedSvgDesign,
};
export { resolveDesignTarget, resolveRenderTarget, resolveSvgDesign };
