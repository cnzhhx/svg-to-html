import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createPixelDiff } from "../core/diff.js";
import {
  collectAssetReferences,
  createFinalOutputPolicyReport,
  resolveReferenceCandidates,
} from "../core/final-output-policy.js";
import { createLayoutBoxReport } from "../core/layout-box.js";
import {
  createModuleDomReconcileReport,
  type ModuleDomReconcileReport,
} from "../core/module-dom-reconcile.js";
import { getOcrProvider, runOcr } from "../core/ocr.js";
import { renderDesignTargets } from "../core/render.js";
import { createTextBoxReport } from "../core/text-box.js";
import {
  buildAutoOcrRegions,
  buildTrackedOcrRegions,
  createTextInsights,
} from "../core/text-diff.js";
import { extractInlineConfig, hasInlineConfig } from "../core/text-layout.js";
import {
  readRegions,
  resolveArtifactDir,
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  writeJsonFile,
  writeTextFile,
} from "../core/utils.js";
import { createWorkflowLintReport } from "../core/workflow-lint.js";
import {
  DIFF_RATIO_THRESHOLD,
  FONT_RENDERING_LIMIT_DIFF_RATIO,
  FONT_RENDERING_LIMIT_GEOMETRY_TOLERANCE_PX,
  MODULE_DIFF_RATIO_THRESHOLD,
} from "../config/runtime.js";
import {
  DIFF_RATIO_GATE_FAILURE_MESSAGE,
  FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE,
  LAYOUT_BOX_GATE_FAILURE_MESSAGE,
  MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE,
  WORKFLOW_LINT_GATE_FAILURE_MESSAGE,
} from "./verify/gate-messages.js";
import {
  buildModuleRegionStats,
  findModuleRegionDiffFailures,
  normalizeModuleRegions,
  summarizeModuleRegions,
} from "./verify/module-regions.js";
import { mergeOcrRegions } from "./verify/ocr-regions.js";
import { writeVerifyReport } from "./verify/report.js";
import type { VerifyOptions, VerifyResult } from "./verify/types.js";

const createPixelDiffWithRetry = async (
  options: Parameters<typeof createPixelDiff>[0],
  onProgress?: (message: string) => void,
) => {
  try {
    return await createPixelDiff(options);
  } catch (error) {
    onProgress?.(
      `Pixel diff failed once; retrying with a fresh browser/server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return createPixelDiff(options);
  }
};

const FULL_VERIFY_CACHE_VERSION = "full-verify-cache-v2";
const OCR_CACHE_VERSION = "ocr-cache-v1";

type FullVerifyCachePayload = {
  createdAt: number;
  key: string;
  result: VerifyResult;
  version: string;
};

type OcrCacheEntry = {
  createdAt: number;
  key: string;
  outputPath: string;
  version: string;
};

type OcrCachePayload = {
  entries: Record<"html" | "svg", OcrCacheEntry | undefined>;
};

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

const hashFile = async (filePath: string) => sha256(await readFile(filePath));

const stripHtmlForSemanticTextHash = (html: string) =>
  html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(
      /\s(?:class|style|id|data-[\w-]+|aria-[\w-]+)=["'][^"']*["']/gi,
      "",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildOcrRegionsKey = (regions: unknown[]) =>
  sha256(JSON.stringify(regions));

const buildOcrCacheKey = async ({
  htmlSource,
  imagePath,
  kind,
  ocrProvider,
  regionsKey,
}: {
  htmlSource?: string;
  imagePath: string;
  kind: "html" | "svg";
  ocrProvider: string;
  regionsKey: string;
}) =>
  sha256(
    JSON.stringify({
      htmlSemanticHash:
        kind === "html" && htmlSource
          ? sha256(stripHtmlForSemanticTextHash(htmlSource))
          : null,
      imageHash: kind === "svg" ? await hashFile(imagePath) : null,
      kind,
      ocrProvider,
      regionsKey,
      version: OCR_CACHE_VERSION,
    }),
  );

const readOcrCache = async (artifactDir: string): Promise<OcrCachePayload> => {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(artifactDir, "verify-ocr-cache.json"), "utf8"),
    ) as OcrCachePayload;
    return {
      entries: {
        html: parsed.entries?.html,
        svg: parsed.entries?.svg,
      },
    };
  } catch {
    return { entries: { html: undefined, svg: undefined } };
  }
};

const writeOcrCache = async ({
  artifactDir,
  cache,
}: {
  artifactDir: string;
  cache: OcrCachePayload;
}) => {
  await writeJsonFile(path.join(artifactDir, "verify-ocr-cache.json"), cache);
};

const copyReusableOcr = async ({
  artifactDir,
  key,
  kind,
  outputPath,
}: {
  artifactDir: string;
  key: string;
  kind: "html" | "svg";
  outputPath: string;
}) => {
  const cache = await readOcrCache(artifactDir);
  const entry = cache.entries[kind];
  if (entry?.version !== OCR_CACHE_VERSION || entry.key !== key) return false;
  try {
    await stat(entry.outputPath);
    if (path.resolve(entry.outputPath) !== path.resolve(outputPath)) {
      await copyFile(entry.outputPath, outputPath);
    }
    return true;
  } catch {
    return false;
  }
};

const rememberOcr = async ({
  artifactDir,
  key,
  kind,
  outputPath,
}: {
  artifactDir: string;
  key: string;
  kind: "html" | "svg";
  outputPath: string;
}) => {
  const cache = await readOcrCache(artifactDir);
  const cachePath = path.join(
    artifactDir,
    `verify-ocr-cache-${kind}${path.extname(outputPath) || ".json"}`,
  );
  try {
    await copyFile(outputPath, cachePath);
    cache.entries[kind] = {
      createdAt: Date.now(),
      key,
      outputPath: cachePath,
      version: OCR_CACHE_VERSION,
    };
    await writeOcrCache({ artifactDir, cache });
  } catch {
    // OCR caching is an optimization only.
  }
};

const createLocalAssetDependencySnapshot = async ({
  design,
  htmlSource,
}: {
  design: Awaited<ReturnType<typeof resolveDesignPair>>;
  htmlSource: string;
}) => {
  const htmlDir = path.dirname(design.htmlPath);
  const refs = [
    ...new Set(collectAssetReferences(htmlSource).map((asset) => asset.ref)),
  ];
  const referencedAssets = await Promise.all(
    refs.map(async (ref) => {
      const candidates = resolveReferenceCandidates(ref, htmlDir);
      for (const candidate of candidates) {
        try {
          const fileStat = await stat(candidate);
          return {
            hash: await hashFile(candidate),
            path: path.resolve(candidate),
            ref,
            size: fileStat.size,
          };
        } catch {
          // Try the next candidate.
        }
      }
      return {
        candidates,
        missing: true,
        ref,
      };
    }),
  );

  const metadataFiles = await Promise.all(
    ["shell-manifest.json"].map(async (fileName) => {
      const filePath = path.join(path.dirname(design.svgPath), "artifacts", fileName);
      try {
        const fileStat = await stat(filePath);
        return {
          fileName,
          hash: await hashFile(filePath),
          size: fileStat.size,
        };
      } catch {
        return {
          fileName,
          missing: true,
        };
      }
    }),
  );

  return {
    metadataFiles,
    referencedAssets,
  };
};

const buildFullVerifyCacheKey = async ({
  design,
  htmlSource,
  ocrProvider,
  regionsPath,
}: {
  design: Awaited<ReturnType<typeof resolveDesignPair>>;
  htmlSource: string;
  ocrProvider: string;
  regionsPath?: string;
}) => {
  const normalizedRegionsPath = regionsPath
    ? toAbsolutePath(regionsPath)
    : undefined;
  const payload = {
    assetDependencies: await createLocalAssetDependencySnapshot({
      design,
      htmlSource,
    }),
    designHeight: design.height,
    designWidth: design.width,
    fontRenderingLimitDiffRatio: FONT_RENDERING_LIMIT_DIFF_RATIO,
    fontRenderingLimitGeometryTolerancePx:
      FONT_RENDERING_LIMIT_GEOMETRY_TOLERANCE_PX,
    htmlHash: sha256(htmlSource),
    moduleDiffRatioThreshold: MODULE_DIFF_RATIO_THRESHOLD,
    ocrProvider,
    platform: process.platform,
    regionsHash: normalizedRegionsPath
      ? await hashFile(normalizedRegionsPath)
      : null,
    svgHash: await hashFile(design.svgPath),
    version: FULL_VERIFY_CACHE_VERSION,
  };
  return sha256(JSON.stringify(payload));
};

const cachedVerifyResultFilesExist = async ({
  artifactDir,
  cacheMtimeMs,
  result,
}: {
  artifactDir: string;
  cacheMtimeMs: number;
  result: VerifyResult;
}) => {
  if (path.resolve(result.artifactDir) !== path.resolve(artifactDir))
    return false;
  const requiredPaths = [
    result.diffPngPath,
    result.htmlPngPath,
    result.svgPngPath,
    result.verifyReportPath,
    path.join(artifactDir, "diff-report.json"),
    result.finalOutputPolicyPath,
    result.layoutBoxReportPath,
    result.textBoxReportPath,
    result.textInsightsPath,
    result.workflowLintPath,
    result.moduleDomReconcilePath,
    result.moduleDomReconcileMarkdownPath,
  ];
  for (const filePath of requiredPaths) {
    if (!filePath) continue;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs > cacheMtimeMs + 1) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const readFullVerifyCache = async ({
  artifactDir,
  key,
}: {
  artifactDir: string;
  key: string;
}) => {
  const cachePath = path.join(artifactDir, "verify-full-cache.json");
  try {
    const cacheStat = await stat(cachePath);
    const parsed = JSON.parse(
      await readFile(cachePath, "utf8"),
    ) as FullVerifyCachePayload;
    if (parsed.version !== FULL_VERIFY_CACHE_VERSION || parsed.key !== key)
      return null;
    if (
      !(await cachedVerifyResultFilesExist({
        artifactDir,
        cacheMtimeMs: cacheStat.mtimeMs,
        result: parsed.result,
      }))
    ) {
      return null;
    }
    return parsed.result;
  } catch {
    return null;
  }
};

const writeFullVerifyCache = async ({
  artifactDir,
  key,
  result,
}: {
  artifactDir: string;
  key: string;
  result: VerifyResult;
}) => {
  try {
    await writeJsonFile(path.join(artifactDir, "verify-full-cache.json"), {
      createdAt: Date.now(),
      key,
      result,
      version: FULL_VERIFY_CACHE_VERSION,
    } satisfies FullVerifyCachePayload);
  } catch {
    // Verification artifacts are the source of truth; cache writes are best effort.
  }
};

type TextBoxFontLimitBlock = {
  deltaX: null | number;
  deltaY: null | number;
  expectedBox?: null | unknown;
};

type TextBoxFontLimitReport = {
  blocks?: TextBoxFontLimitBlock[];
  comparedBlocks?: number;
  matchedBlocks?: number;
};

const readJsonOrNull = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const evaluateFontRenderingLimit = async ({
  artifactDir,
  diffRatio,
  finalOutputPolicyPassed,
  layoutBoxPassed,
  textContentPriorityIssueCount,
  workflowLintPassed,
}: {
  artifactDir: string;
  diffRatio: number;
  finalOutputPolicyPassed: boolean;
  layoutBoxPassed: boolean;
  textContentPriorityIssueCount: number;
  workflowLintPassed: boolean;
}) => {
  if (diffRatio <= DIFF_RATIO_THRESHOLD) return null;
  if (diffRatio > FONT_RENDERING_LIMIT_DIFF_RATIO) return null;
  if (
    !layoutBoxPassed ||
    !workflowLintPassed ||
    finalOutputPolicyPassed === false
  )
    return null;
  if (textContentPriorityIssueCount > 0) return null;

  const report = await readJsonOrNull<TextBoxFontLimitReport>(
    path.join(artifactDir, "text-box-report.json"),
  );
  const comparedBlocks = report?.comparedBlocks ?? report?.blocks?.length ?? 0;
  const matchedBlocks =
    report?.matchedBlocks ??
    report?.blocks?.filter((block) => block.expectedBox).length ??
    0;
  if (comparedBlocks <= 0 || matchedBlocks / comparedBlocks < 0.8) return null;

  const matched = (report?.blocks ?? []).filter((block) => block.expectedBox);
  const stablePositionCount = matched.filter(
    (block) =>
      Math.abs(block.deltaX ?? 0) <=
        FONT_RENDERING_LIMIT_GEOMETRY_TOLERANCE_PX &&
      Math.abs(block.deltaY ?? 0) <= FONT_RENDERING_LIMIT_GEOMETRY_TOLERANCE_PX,
  ).length;
  if (matched.length <= 0 || stablePositionCount / matched.length < 0.65)
    return null;

  return `diff ${(diffRatio * 100).toFixed(2)}% is above the strict ${(DIFF_RATIO_THRESHOLD * 100).toFixed(2)}% gate but within font-rendering tolerance ${(FONT_RENDERING_LIMIT_DIFF_RATIO * 100).toFixed(2)}%; text content and primary geometry gates are stable`;
};

const verifyDesign = async (
  svgPath: string,
  onProgress?: (message: string) => void,
  customArtifactDir?: string,
  regionsPath?: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> => {
  const mode = options.mode ?? "full";
  const resolvedDesign = options.htmlPath
    ? await resolveSvgDesign(svgPath, { scale: options.scale })
    : await resolveDesignPair(svgPath, { scale: options.scale });
  const design = options.htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(options.htmlPath),
      }
    : resolvedDesign;
  const artifactDir = await resolveArtifactDir(
    design.svgPath,
    customArtifactDir,
  );
  const effectiveRegionsPath =
    regionsPath && regionsPath !== "-" ? regionsPath : undefined;
  const inputRegions = effectiveRegionsPath
    ? normalizeModuleRegions(await readRegions(effectiveRegionsPath))
    : [];
  const ocrProvider = getOcrProvider();
  let htmlSource: string | undefined;
  let fullVerifyCacheKey: string | undefined;

  if (mode === "full") {
    htmlSource = await readFile(design.htmlPath, "utf8");
    fullVerifyCacheKey = await buildFullVerifyCacheKey({
      design,
      htmlSource,
      ocrProvider,
      regionsPath: effectiveRegionsPath,
    });
    const cachedResult = await readFullVerifyCache({
      artifactDir,
      key: fullVerifyCacheKey,
    });
    if (cachedResult) {
      onProgress?.(
        "Full verification cache hit; reusing reports for unchanged HTML/SVG.",
      );
      onProgress?.(`Diff ratio: ${cachedResult.diffRatio}`);
      return {
        ...cachedResult,
        mode,
      };
    }
  }

  onProgress?.("Rendering SVG and HTML to PNG...");

  const renderResult = await renderDesignTargets(design.svgPath, artifactDir, {
    htmlPath: options.htmlPath ? design.htmlPath : undefined,
    scale: options.scale,
    sourceHtmlPath: options.sourceHtmlPath,
  });

  onProgress?.(
    inputRegions.length
      ? `Running pixel diff with ${inputRegions.length} module regions...`
      : "Running pixel diff...",
  );

  const diffResult = await createPixelDiffWithRetry(
    {
      artifactDir,
      htmlPngPath: renderResult.htmlPngPath,
      regions: inputRegions,
      svgPngPath: renderResult.svgPngPath,
    },
    onProgress,
  );
  const regionStats = diffResult.report.regionStats ?? [];
  const moduleRegionStats = buildModuleRegionStats({
    regions: inputRegions,
    regionStats,
  });
  const moduleRegionSummary = summarizeModuleRegions(moduleRegionStats);
  const moduleRegionDiffFailures =
    findModuleRegionDiffFailures(moduleRegionStats);
  const moduleRegionDiffPassed = moduleRegionDiffFailures.length === 0;

  onProgress?.(`Diff ratio: ${diffResult.report.diffRatio}`);

  if (mode === "fast") {
    let finalOutputPolicyPassed = options.runFinalOutputPolicy === false;
    let finalOutputPolicyPath: string | undefined;
    try {
      if (options.runFinalOutputPolicy === false) {
        onProgress?.(
          "Final output policy skipped for fast visual-only verification.",
        );
      } else {
        onProgress?.("Running final output policy...");
        const finalPolicyResult = await createFinalOutputPolicyReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          scale: options.scale,
        });
        finalOutputPolicyPassed = finalPolicyResult.report.passed;
        finalOutputPolicyPath = finalPolicyResult.markdownPath;
        onProgress?.(
          `Final output policy: ${finalPolicyResult.report.issueCount} issues (${finalPolicyResult.report.criticalIssueCount} critical)`,
        );
      }
    } catch (error) {
      onProgress?.(
        `Final output policy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const verifyReportPath = path.join(artifactDir, "verify-report.fast.json");
    await writeJsonFile(verifyReportPath, {
      diffRatio: diffResult.report.diffRatio,
      diffPixels: diffResult.report.diffPixels,
      finalOutputPolicyPassed,
      finalOutputPolicyPath,
      totalPixels: diffResult.report.totalPixels,
      clusters: diffResult.report.clusters?.length ?? 0,
      mode,
      htmlImageErrors: renderResult.htmlImageErrors,
      htmlImageIntegrityPassed: renderResult.htmlImageErrors.length === 0,
      sourceImageErrors: renderResult.sourceImageErrors,
      sourceImageIntegrityPassed: renderResult.sourceImageErrors.length === 0,
      sourceRenderMode: renderResult.sourceRenderMode,
      svgPngPath: renderResult.svgPngPath,
      htmlPngPath: renderResult.htmlPngPath,
      diffPngPath: diffResult.diffPngPath,
      ...(effectiveRegionsPath
        ? {
            regionsPath: effectiveRegionsPath,
            regionStats,
            moduleRegionDiffFailures,
            moduleRegionDiffPassed,
            moduleRegionDiffThreshold: MODULE_DIFF_RATIO_THRESHOLD,
            moduleRegionStats,
            moduleRegionSummary,
          }
        : {}),
    });
    onProgress?.("Fast verification complete.");

    return {
      artifactDir,
      diffPngPath: diffResult.diffPngPath,
      diffRatio: diffResult.report.diffRatio,
      htmlPngPath: renderResult.htmlPngPath,
      layoutBoxPassed: true,
      mode,
      finalOutputPolicyPassed,
      finalOutputPolicyPath,
      htmlImageErrors: renderResult.htmlImageErrors,
      htmlImageIntegrityPassed: renderResult.htmlImageErrors.length === 0,
      svgPngPath: renderResult.svgPngPath,
      workflowLintPassed: true,
      verifyReportPath,
      ...(effectiveRegionsPath
        ? {
            regionsPath: effectiveRegionsPath,
            regionStats,
            moduleRegionDiffFailures,
            moduleRegionDiffPassed,
            moduleRegionDiffThreshold: MODULE_DIFF_RATIO_THRESHOLD,
            moduleRegionStats,
            moduleRegionSummary,
          }
        : {}),
    };
  }

  htmlSource = htmlSource ?? (await readFile(design.htmlPath, "utf8"));
  const trackedOcrRegions = hasInlineConfig(htmlSource)
    ? buildTrackedOcrRegions({
        blocks: extractInlineConfig(htmlSource).blocks ?? [],
        height: design.height,
        width: design.width,
      })
    : [];
  const diffOcrRegions = buildAutoOcrRegions({
    diffReport: diffResult.report,
    height: design.height,
    width: design.width,
  });
  // OCR focuses on explicit tracked text regions plus the noisiest visual diff
  // regions, keeping the expensive compare narrow but still regression-aware.
  const autoOcrRegions = mergeOcrRegions(trackedOcrRegions, diffOcrRegions);

  const svgOcrPath = path.join(artifactDir, "svg-ocr.json");
  const htmlOcrPath = path.join(artifactDir, "html-ocr.json");
  let ocrRegionsPath: string | undefined;
  if (autoOcrRegions.length) {
    ocrRegionsPath = path.join(artifactDir, "auto-text-regions.json");
    await writeJsonFile(ocrRegionsPath, autoOcrRegions);
  }

  const ocrRegionsKey = buildOcrRegionsKey(autoOcrRegions);
  const svgOcrCacheKey = await buildOcrCacheKey({
    imagePath: renderResult.svgPngPath,
    kind: "svg",
    ocrProvider,
    regionsKey: ocrRegionsKey,
  });
  const htmlOcrCacheKey = await buildOcrCacheKey({
    htmlSource,
    imagePath: renderResult.htmlPngPath,
    kind: "html",
    ocrProvider,
    regionsKey: ocrRegionsKey,
  });

  let ocrAnalysisFailed = false;
  try {
    const reusedSvgOcr = options.reuseCachedOcr
      ? await copyReusableOcr({
          artifactDir,
          key: svgOcrCacheKey,
          kind: "svg",
          outputPath: svgOcrPath,
        })
      : false;
    if (reusedSvgOcr) {
      onProgress?.(
        `Reusing cached SVG OCR (${autoOcrRegions.length} regions)...`,
      );
    } else {
      onProgress?.(
        `Running OCR via ${ocrProvider} on SVG render (${autoOcrRegions.length} regions)...`,
      );
      await runOcr({
        imagePath: renderResult.svgPngPath,
        outputPath: svgOcrPath,
        regionsPath: ocrRegionsPath,
      });
      await rememberOcr({
        artifactDir,
        key: svgOcrCacheKey,
        kind: "svg",
        outputPath: svgOcrPath,
      });
    }

    const reusedHtmlOcr = options.reuseCachedOcr
      ? await copyReusableOcr({
          artifactDir,
          key: htmlOcrCacheKey,
          kind: "html",
          outputPath: htmlOcrPath,
        })
      : false;
    if (reusedHtmlOcr) {
      onProgress?.("Reusing cached HTML OCR for unchanged semantic text...");
    } else {
      onProgress?.(`Running OCR via ${ocrProvider} on HTML render...`);
      await runOcr({
        imagePath: renderResult.htmlPngPath,
        outputPath: htmlOcrPath,
        regionsPath: ocrRegionsPath,
      });
      await rememberOcr({
        artifactDir,
        key: htmlOcrCacheKey,
        kind: "html",
        outputPath: htmlOcrPath,
      });
    }
  } catch (error) {
    ocrAnalysisFailed = true;
    onProgress?.(
      `OCR failed (${ocrProvider}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const [
    textBoxReport,
    layoutBoxReport,
    workflowLintReport,
    finalOutputPolicyReport,
    moduleDomReconcileReport,
  ] = await Promise.all([
    (async () => {
      try {
        onProgress?.("Running text-box comparison...");
        const textBoxResult = await createTextBoxReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          scale: options.scale,
        });
        onProgress?.(
          `Text-box report: ${textBoxResult.report.comparedBlocks} blocks compared, ${textBoxResult.report.matchedBlocks} matched`,
        );
        return {
          textBoxReportPath: textBoxResult.markdownPath,
          textGeometryPriorityIssueCount:
            textBoxResult.report.priorityIssues.length,
        };
      } catch (error) {
        onProgress?.(
          `Text-box comparison skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          textBoxReportPath: undefined,
          textGeometryPriorityIssueCount: 1,
        };
      }
    })(),
    (async () => {
      try {
        onProgress?.("Running layout-box comparison...");
        const layoutBoxResult = await createLayoutBoxReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          scale: options.scale,
        });
        const layoutBoxPassed =
          !("passed" in layoutBoxResult.report) ||
          layoutBoxResult.report.passed !== false;
        if (!layoutBoxPassed) {
          onProgress?.(
            "WARNING: layout-box report has comparedBlocks=0 — text geometry feedback loop is NOT active",
          );
        } else {
          onProgress?.("Layout-box report generated");
        }
        return {
          layoutBoxPassed,
          layoutBoxReportPath: layoutBoxResult.markdownPath,
        };
      } catch (error) {
        onProgress?.(
          `Layout-box comparison skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          layoutBoxPassed: false,
          layoutBoxReportPath: undefined,
        };
      }
    })(),
    (async () => {
      try {
        onProgress?.("Running workflow lint...");
        const workflowLintResult = await createWorkflowLintReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          scale: options.scale,
        });
        onProgress?.(
          `Workflow lint: ${workflowLintResult.report.issueCount} issues (${workflowLintResult.report.criticalIssueCount} critical)`,
        );
        return {
          workflowLintPassed: workflowLintResult.report.passed,
          workflowLintPath: workflowLintResult.markdownPath,
        };
      } catch (error) {
        onProgress?.(
          `Workflow lint skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          workflowLintPassed: false,
          workflowLintPath: undefined,
        };
      }
    })(),
    (async () => {
      try {
        onProgress?.("Running final output policy...");
        const finalPolicyResult = await createFinalOutputPolicyReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          scale: options.scale,
        });
        onProgress?.(
          `Final output policy: ${finalPolicyResult.report.issueCount} issues (${finalPolicyResult.report.criticalIssueCount} critical)`,
        );
        return {
          finalOutputPolicyPassed: finalPolicyResult.report.passed,
          finalOutputPolicyPath: finalPolicyResult.markdownPath,
        };
      } catch (error) {
        onProgress?.(
          `Final output policy failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          finalOutputPolicyPassed: false,
          finalOutputPolicyPath: undefined,
        };
      }
    })(),
    (async () => {
      try {
        const modulePlanPath = path.join(
          artifactDir,
          "modules",
          "module-plan.json",
        );
        await stat(modulePlanPath);
        onProgress?.("Running module DOM reconcile...");
        const reconcile = await createModuleDomReconcileReport({
          artifactDir,
          htmlPath: options.htmlPath ? design.htmlPath : undefined,
          inputPath: svgPath,
          modulePlanPath,
          scale: options.scale,
        });
        onProgress?.(
          `Module DOM reconcile: ${reconcile.report.domModuleCount} DOM module(s), ${reconcile.report.unplannedDomModuleIds.length} unplanned`,
        );
        return {
          moduleDomReconcileMarkdownPath: reconcile.markdownPath,
          moduleDomReconcilePath: reconcile.jsonPath,
          moduleDomReconcileSummary: reconcile.report,
        };
      } catch (error) {
        onProgress?.(
          `Module DOM reconcile skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          moduleDomReconcileMarkdownPath: undefined,
          moduleDomReconcilePath: undefined,
          moduleDomReconcileSummary: undefined as
            | ModuleDomReconcileReport
            | undefined,
        };
      }
    })(),
  ]);

  const { textBoxReportPath, textGeometryPriorityIssueCount } = textBoxReport;
  const { layoutBoxPassed, layoutBoxReportPath } = layoutBoxReport;
  const { workflowLintPassed, workflowLintPath } = workflowLintReport;
  const { finalOutputPolicyPassed, finalOutputPolicyPath } =
    finalOutputPolicyReport;
  const {
    moduleDomReconcileMarkdownPath,
    moduleDomReconcilePath,
    moduleDomReconcileSummary,
  } = moduleDomReconcileReport;

  let textInsightsPath: string | undefined;
  let textContentPriorityIssueCount = ocrAnalysisFailed ? 1 : 0;
  try {
    onProgress?.("Generating text insights...");
    const textInsights = await createTextInsights({
      autoOcrRegions: autoOcrRegions.length ? autoOcrRegions : undefined,
      clusters: diffResult.report.clusters ?? [],
      height: design.height,
      htmlOcrPath,
      svgOcrPath,
      textBoxReportMarkdownPath: textBoxReportPath,
      width: design.width,
    });
    textContentPriorityIssueCount = textInsights.contentPriorityIssues.length;
    textInsightsPath = path.join(artifactDir, "text-insights.md");
    await writeTextFile(textInsightsPath, textInsights.markdown);
    onProgress?.(
      `Text insights: ${textInsights.contentPriorityIssues.length} priority issues`,
    );
  } catch (error) {
    onProgress?.(
      `Text insights skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    textContentPriorityIssueCount = Math.max(textContentPriorityIssueCount, 1);
  }

  const fontRenderingLimitReason = await evaluateFontRenderingLimit({
    artifactDir,
    diffRatio: diffResult.report.diffRatio,
    finalOutputPolicyPassed,
    layoutBoxPassed,
    textContentPriorityIssueCount,
    workflowLintPassed,
  });
  const fontRenderingLimitLikely = Boolean(fontRenderingLimitReason);
  if (fontRenderingLimitLikely) {
    onProgress?.(`Font rendering limit likely: ${fontRenderingLimitReason}`);
  }

  const verifyReportPath = await writeVerifyReport({
    agentHints: diffResult.report.agentHints ?? [],
    artifactDir,
    clusters: diffResult.report.clusters?.length ?? 0,
    diffPixels: diffResult.report.diffPixels,
    diffPngPath: diffResult.diffPngPath,
    diffRatio: diffResult.report.diffRatio,
    finalOutputPolicyPassed,
    finalOutputPolicyPath,
    fontRenderingLimitLikely,
    fontRenderingLimitReason: fontRenderingLimitReason ?? undefined,
    htmlImageErrors: renderResult.htmlImageErrors,
    htmlImageIntegrityPassed: renderResult.htmlImageErrors.length === 0,
    sourceImageErrors: renderResult.sourceImageErrors,
    sourceImageIntegrityPassed: renderResult.sourceImageErrors.length === 0,
    sourceRenderMode: renderResult.sourceRenderMode,
    htmlOcrPath,
    htmlPngPath: renderResult.htmlPngPath,
    layoutBoxPassed,
    layoutBoxReportPath,
    moduleDomReconcileMarkdownPath,
    moduleDomReconcilePath,
    moduleDomReconcileSummary,
    moduleRegionDiffFailures,
    moduleRegionDiffPassed,
    moduleRegionStats,
    moduleRegionSummary,
    ocrProvider,
    regionStats,
    regionsPath: effectiveRegionsPath,
    svgOcrPath,
    svgPngPath: renderResult.svgPngPath,
    textBoxReportPath,
    textContentPriorityIssueCount,
    textGeometryPriorityIssueCount,
    textPriorityIssueCount:
      textContentPriorityIssueCount + textGeometryPriorityIssueCount,
    textInsightsPath,
    totalPixels: diffResult.report.totalPixels,
    workflowLintPassed,
    workflowLintPath,
  });

  onProgress?.("Verification complete.");

  const fullResult: VerifyResult = {
    artifactDir,
    diffPngPath: diffResult.diffPngPath,
    diffRatio: diffResult.report.diffRatio,
    htmlImageErrors: renderResult.htmlImageErrors,
    htmlImageIntegrityPassed: renderResult.htmlImageErrors.length === 0,
    sourceImageErrors: renderResult.sourceImageErrors,
    sourceImageIntegrityPassed: renderResult.sourceImageErrors.length === 0,
    sourceRenderMode: renderResult.sourceRenderMode,
    htmlPngPath: renderResult.htmlPngPath,
    layoutBoxPassed,
    mode,
    svgPngPath: renderResult.svgPngPath,
    textBoxReportPath,
    layoutBoxReportPath,
    textInsightsPath,
    textContentPriorityIssueCount,
    textGeometryPriorityIssueCount,
    textPriorityIssueCount:
      textContentPriorityIssueCount + textGeometryPriorityIssueCount,
    workflowLintPassed,
    workflowLintPath,
    finalOutputPolicyPassed,
    finalOutputPolicyPath,
    fontRenderingLimitLikely,
    fontRenderingLimitReason: fontRenderingLimitReason ?? undefined,
    moduleDomReconcilePath,
    moduleDomReconcileMarkdownPath,
    moduleDomReconcileSummary,
    verifyReportPath,
    ocrProvider,
    ...(effectiveRegionsPath
      ? {
          regionsPath: effectiveRegionsPath,
          regionStats,
          moduleRegionDiffFailures,
          moduleRegionDiffPassed,
          moduleRegionDiffThreshold: MODULE_DIFF_RATIO_THRESHOLD,
          moduleRegionStats,
          moduleRegionSummary,
        }
      : {}),
  };
  if (fullVerifyCacheKey) {
    await writeFullVerifyCache({
      artifactDir,
      key: fullVerifyCacheKey,
      result: fullResult,
    });
  }
  return fullResult;
};

export type { VerifyResult };
export {
  DIFF_RATIO_GATE_FAILURE_MESSAGE,
  FINAL_OUTPUT_POLICY_GATE_FAILURE_MESSAGE,
  LAYOUT_BOX_GATE_FAILURE_MESSAGE,
  MODULE_REGION_DIFF_GATE_FAILURE_MESSAGE,
  WORKFLOW_LINT_GATE_FAILURE_MESSAGE,
  verifyDesign,
};
