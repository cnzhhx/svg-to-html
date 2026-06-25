import { createPixelDiff } from "../core/diff/index.js";
import { renderDesignTargets } from "../core/render.js";
import { resolveArtifactDir } from "../core/paths.js";
import { resolveRenderTarget } from "../core/design-resolve.js";

type VerifyMode = "full" | "fast";

type VerifyResult = {
  artifactDir: string;
  diffRatio: number;
  renderPngPath: string;
  svgPngPath: string;
  mode?: VerifyMode;
  sourceBasis?: string;
  sourceRenderMode?: "svg-image" | "html";
};

type VerifyOptions = {
  mode?: VerifyMode;
  renderEntryPath: string;
  scale?: number;
  signal?: AbortSignal;
  sourceBasis?: string;
  sourceHtmlPath?: string;
};

const throwIfAbortSignal = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "aborted",
  );
  error.name = "AbortError";
  throw error;
};

const createPixelDiffWithRetry = async (
  options: Parameters<typeof createPixelDiff>[0],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
) => {
  try {
    throwIfAbortSignal(signal);
    return await createPixelDiff(options);
  } catch (error) {
    throwIfAbortSignal(signal);
    onProgress?.(
      `Pixel diff failed once; retrying with a fresh browser/server: ${error instanceof Error ? error.message : String(error)}`,
    );
    throwIfAbortSignal(signal);
    return createPixelDiff(options);
  }
};

const verifyDesign = async (
  svgPath: string,
  onProgress: ((message: string) => void) | undefined,
  customArtifactDir: string | undefined,
  options: VerifyOptions,
): Promise<VerifyResult> => {
  const mode = options.mode ?? "full";
  if (!options.renderEntryPath) {
    throw new Error("verifyDesign requires renderEntryPath");
  }

  throwIfAbortSignal(options.signal);
  const design = await resolveRenderTarget(svgPath, {
    renderEntryPath: options.renderEntryPath,
    scale: options.scale,
  });
  throwIfAbortSignal(options.signal);
  const artifactDir = await resolveArtifactDir(
    design.svgPath,
    customArtifactDir,
  );

  throwIfAbortSignal(options.signal);
  onProgress?.("Rendering SVG source and render entry to PNG...");
  const renderResult = await renderDesignTargets(design.svgPath, artifactDir, {
    renderEntryPath: design.renderEntryPath,
    scale: options.scale,
    sourceBasis: options.sourceBasis,
    sourceHtmlPath: options.sourceHtmlPath,
  });

  throwIfAbortSignal(options.signal);
  onProgress?.("Running pixel diff...");
  const diffResult = await createPixelDiffWithRetry(
    {
      artifactDir,
      renderPngPath: renderResult.renderPngPath,
      scale: options.scale,
      svgPngPath: renderResult.svgPngPath,
      viewportHeight: design.height,
      viewportWidth: design.width,
    },
    onProgress,
    options.signal,
  );

  throwIfAbortSignal(options.signal);
  onProgress?.(`Diff ratio: ${diffResult.report.diffRatio}`);

  const result: VerifyResult = {
    artifactDir,
    diffRatio: diffResult.report.diffRatio,
    renderPngPath: renderResult.renderPngPath,
    svgPngPath: renderResult.svgPngPath,
    mode,
    sourceBasis: renderResult.sourceBasis,
    sourceRenderMode: renderResult.sourceRenderMode,
  };

  if (mode === "fast") {
    onProgress?.("Fast verification complete.");
    return result;
  }

  onProgress?.("Verification complete.");
  return result;
};

export type { VerifyMode, VerifyResult };
export { verifyDesign };
