import type { Region } from "./utils.js";

type AssetMetadataEntry = {
  assetKind?: unknown;
  assetName?: unknown;
  assetRole?: unknown;
  assetType?: unknown;
  category?: unknown;
  containsIntrinsicText?: unknown;
  containsText?: unknown;
  description?: unknown;
  kind?: unknown;
  matchedOcrBlockIds?: unknown;
  mustUse?: unknown;
  name?: unknown;
  ocrStatus?: unknown;
  overlapsOcrText?: unknown;
  reason?: unknown;
  source?: unknown;
  status?: unknown;
  textTreatment?: unknown;
  type?: unknown;
  [key: string]: unknown;
};

type AssetCoverage = {
  assetModuleOverlapRatio?: number;
  moduleRatio?: number;
  pageRatio?: number;
};

type AssetRiskLevel = "low" | "medium" | "high" | "blocked";

type NormalizedAssetMetadata = {
  assetRole: string;
  coverage: AssetCoverage;
  mayUseInFinalLayer: boolean;
  mayUseInModule: boolean;
  priority: number;
  recommendedUse: "allow" | "background-underlay-only" | "block" | "review";
  riskLevel: AssetRiskLevel;
  riskReasons: string[];
  textTreatment: string;
};

const isString = (value: unknown): value is string => typeof value === "string";

const getDescriptor = (entry: AssetMetadataEntry) =>
  [
    entry.assetRole,
    entry.assetType,
    entry.assetKind,
    entry.assetName,
    entry.category,
    entry.description,
    entry.kind,
    entry.name,
    entry.reason,
    entry.source,
    entry.textTreatment,
    entry.type,
  ]
    .filter(isString)
    .join(" ")
    .toLowerCase();

const area = (region: Region | undefined) =>
  region ? Math.max(1, region.width * region.height) : undefined;

const intersectsArea = (left: Region, right: Region) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

const coverageRatio = (value: number | undefined) =>
  value === undefined ? undefined : Number(value.toFixed(6));

const inferAssetRole = (entry: AssetMetadataEntry) => {
  const descriptor = getDescriptor(entry);
  if (/atomic-svg-node-visual-text-asset/i.test(descriptor)) {
    return "atomic-svg-node-visual-text-asset";
  }
  if (/\b(?:photo|bitmap|raster|image)\b/i.test(descriptor)) {
    return "photo-or-bitmap";
  }
  if (
    /\b(?:icon|illustration|logo|avatar|thumbnail|cover)\b/i.test(descriptor)
  ) {
    return "icon-or-illustration";
  }
  if (
    /\b(?:background|underlay|backdrop|pattern|texture)\b/i.test(descriptor)
  ) {
    return "background-underlay";
  }
  if (
    /\b(?:layout-shell|page|full-page|whole-page|shell|fallback|original-svg|page-crop|svg-crop)\b/i.test(
      descriptor,
    )
  ) {
    return "layout-shell";
  }
  return "visual-asset";
};

const normalizeTextTreatment = (entry: AssetMetadataEntry) => {
  if (isString(entry.textTreatment) && entry.textTreatment.trim()) {
    return entry.textTreatment.trim();
  }
  if (entry.containsText === false || entry.containsIntrinsicText === false) {
    return "ocr-checked-no-ordinary-text";
  }
  if (entry.containsText === true || entry.containsIntrinsicText === true) {
    return "review-required-text-like-asset";
  }
  return "unknown";
};

const hasNoOrdinaryTextSignal = (
  entry: AssetMetadataEntry,
  textTreatment: string,
) =>
  entry.containsText === false ||
  entry.containsIntrinsicText === false ||
  /\b(?:no[-_\s]?ordinary[-_\s]?text|no[-_\s]?readable[-_\s]?text|no[-_\s]?text|ocr[-_\s]?checked[-_\s]?no[-_\s]?ordinary[-_\s]?text)\b/i.test(
    textTreatment,
  );

const hasOcrOverlap = (entry: AssetMetadataEntry) =>
  entry.overlapsOcrText === true ||
  (Array.isArray(entry.matchedOcrBlockIds) &&
    entry.matchedOcrBlockIds.length > 0);

const computeCoverage = ({
  assetBox,
  designRegion,
  moduleRegion,
}: {
  assetBox?: Region;
  designRegion?: Region;
  moduleRegion?: Region;
}): AssetCoverage => {
  const assetArea = area(assetBox);
  const pageArea = area(designRegion);
  const moduleArea = area(moduleRegion);
  const moduleOverlap =
    assetBox && moduleRegion
      ? intersectsArea(assetBox, moduleRegion)
      : undefined;

  return {
    assetModuleOverlapRatio: coverageRatio(
      assetArea && moduleOverlap !== undefined
        ? moduleOverlap / assetArea
        : undefined,
    ),
    moduleRatio: coverageRatio(
      moduleArea && moduleOverlap !== undefined
        ? moduleOverlap / moduleArea
        : undefined,
    ),
    pageRatio: coverageRatio(
      assetArea && pageArea ? assetArea / pageArea : undefined,
    ),
  };
};

const normalizeAssetMetadata = ({
  assetBox,
  designRegion,
  entry,
  moduleRegion,
}: {
  assetBox?: Region;
  designRegion?: Region;
  entry: AssetMetadataEntry;
  moduleRegion?: Region;
}): NormalizedAssetMetadata => {
  const assetRole = inferAssetRole(entry);
  const textTreatment = normalizeTextTreatment(entry);
  const coverage = computeCoverage({ assetBox, designRegion, moduleRegion });
  const descriptor = getDescriptor(entry);
  const noOrdinaryText = hasNoOrdinaryTextSignal(entry, textTreatment);
  const isAtomicTextAsset =
    assetRole === "atomic-svg-node-visual-text-asset" ||
    /atomic-svg-node-visual-text-asset/i.test(textTreatment);
  const isBackgroundUnderlay = assetRole === "background-underlay";
  const isImageLike =
    assetRole === "icon-or-illustration" ||
    assetRole === "photo-or-bitmap" ||
    assetRole === "atomic-svg-node-visual-text-asset";
  const isPageOrShellDescriptor =
    /\b(?:layout-shell|page|full-page|whole-page|shell|fallback|original-svg|page-crop|svg-crop)\b|(?:整页|页面|大壳层|兜底)/i.test(
      descriptor,
    );
  const pageRatio = coverage.pageRatio ?? 0;
  const moduleRatio = coverage.moduleRatio ?? 0;
  const assetModuleOverlapRatio = coverage.assetModuleOverlapRatio ?? 0;
  const fullPageLike = pageRatio >= 0.36;
  const moduleShellLike = moduleRatio >= 0.92 && !isImageLike;
  const atomicTooLarge =
    isAtomicTextAsset && (pageRatio >= 0.08 || moduleRatio >= 0.45);
  const isReadyPreExtractedStaticAsset =
    entry.status === "ready" &&
    noOrdinaryText &&
    entry.containsText !== true &&
    entry.containsIntrinsicText !== true;
  const riskReasons: string[] = [];

  if (entry.containsText === true && !isAtomicTextAsset) {
    riskReasons.push(
      "contains ordinary text without allowed atomic treatment",
    );
  }
  if (entry.containsIntrinsicText === true && !isAtomicTextAsset) {
    riskReasons.push(
      "contains intrinsic text without allowed atomic treatment",
    );
  }
  if (
    hasOcrOverlap(entry) &&
    !isReadyPreExtractedStaticAsset &&
    !isBackgroundUnderlay &&
    !isAtomicTextAsset
  ) {
    riskReasons.push(
      "overlaps OCR text but is not a declared background underlay",
    );
  }
  if (
    isPageOrShellDescriptor &&
    !isReadyPreExtractedStaticAsset &&
    !(isBackgroundUnderlay && noOrdinaryText)
  ) {
    riskReasons.push("descriptor looks like page/layout shell/fallback");
  }
  if (
    fullPageLike &&
    !isReadyPreExtractedStaticAsset &&
    !(isBackgroundUnderlay && noOrdinaryText)
  ) {
    riskReasons.push(`large page coverage ${(pageRatio * 100).toFixed(1)}%`);
  }
  if (moduleShellLike && !isReadyPreExtractedStaticAsset) {
    riskReasons.push(
      `large module shell coverage ${(moduleRatio * 100).toFixed(1)}%`,
    );
  }
  if (atomicTooLarge) {
    riskReasons.push(
      "atomic SVG visual-text asset is too large for module/page coverage",
    );
  }
  if (!noOrdinaryText && !isAtomicTextAsset) {
    riskReasons.push("missing no-ordinary-text metadata");
  }

  const blocked =
    !isReadyPreExtractedStaticAsset &&
    (riskReasons.some((reason) =>
      /contains|intrinsic|page\/layout shell|large page|large module|too large|missing no-ordinary-text/i.test(
        reason,
      ),
    ) ||
      (hasOcrOverlap(entry) &&
        !isBackgroundUnderlay &&
        !isAtomicTextAsset));

  const backgroundUnderlayOnly =
    !isReadyPreExtractedStaticAsset &&
    isBackgroundUnderlay &&
    noOrdinaryText &&
    (hasOcrOverlap(entry) || fullPageLike || moduleRatio >= 0.72);

  const mayUseInModule =
    !blocked &&
    !backgroundUnderlayOnly &&
    assetModuleOverlapRatio >= 0.2 &&
    moduleRatio < 0.92;
  const mayUseInFinalLayer = !blocked || backgroundUnderlayOnly;
  const riskLevel: AssetRiskLevel = blocked
    ? "blocked"
    : backgroundUnderlayOnly
      ? "medium"
      : riskReasons.length
        ? "high"
        : "low";
  const recommendedUse = blocked
    ? "block"
    : backgroundUnderlayOnly
      ? "background-underlay-only"
      : riskLevel === "low"
        ? "allow"
        : "review";

  const rolePriority =
    assetRole === "icon-or-illustration"
      ? 700
      : assetRole === "atomic-svg-node-visual-text-asset"
        ? 650
        : assetRole === "photo-or-bitmap"
          ? 600
          : assetRole === "visual-asset"
            ? 400
            : 100;
  const priority = Math.round(
    rolePriority +
      Math.min(250, assetModuleOverlapRatio * 250) +
      Math.min(100, moduleRatio * 100) -
      riskReasons.length * 80,
  );

  return {
    assetRole,
    coverage,
    mayUseInFinalLayer,
    mayUseInModule,
    priority,
    recommendedUse,
    riskLevel,
    riskReasons,
    textTreatment,
  };
};

export { normalizeAssetMetadata };
export type { AssetCoverage, AssetMetadataEntry, NormalizedAssetMetadata };
