import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { safeDecodeUri } from "../core/io.js";
import { detectOcrSupport, runOcr, type OcrResult } from "../core/ocr.js";
import type { Region } from "../core/utils.js";

type JsonRecord = Record<string, unknown>;

type ModuleOutputAllowedAsset = {
  assetId?: null | string;
  assetKind?: null | string;
  assetName?: null | string;
  assetPath?: null | string;
  assetRole?: null | string;
  assetType?: null | string;
  avifPath?: null | string;
  bitmapReason?: null | string;
  box?: Region;
  containsIntrinsicText?: boolean;
  containsText?: boolean;
  containerId?: string;
  htmlRef?: null | string;
  jpegPath?: null | string;
  jpgPath?: null | string;
  kind?: null | string;
  matchedOcrBlockIds?: string[];
  mediaType?: null | string;
  mimeType?: null | string;
  name?: null | string;
  path?: null | string;
  pngPath?: null | string;
  overlapsOcrText?: boolean;
  relativePath?: null | string;
  source?: null | string;
  sourcePath?: null | string;
  svgPath?: null | string;
  textTreatment?: null | string;
  type?: null | string;
  url?: null | string;
  webpPath?: null | string;
  [key: string]: unknown;
};

type ModuleOutputDesign = {
  height?: number;
  name?: string;
  svgPath?: string;
  width?: number;
};

type ModuleOutputPayload = {
  fragmentCss: string;
  fragmentHtml: string;
  manifest?: unknown;
  manifestRaw: string;
  textLayoutRaw: string;
};

type ModuleOutputPolicy = {
  allowedAssets?: ModuleOutputAllowedAsset[];
  design?: ModuleOutputDesign;
  generatedAssetOcr?: GeneratedBitmapAssetOcrResult[];
  htmlPath?: string;
  moduleDir: string;
  moduleId: string;
  moduleRegion?: Region;
  originalSvgPath?: string;
};

type AssetReference = {
  ref: string;
  source: string;
};

type GeneratedAssetDeclaration = {
  box?: Region;
  raw: ModuleOutputAllowedAsset;
  ref?: string;
};

type GeneratedBitmapAssetOcrLine = {
  boundingBox: Region;
  confidence: number;
  text: string;
};

type GeneratedBitmapAssetOcrResult = {
  error?: string;
  fullText?: string;
  imagePath?: string;
  lines: GeneratedBitmapAssetOcrLine[];
  outputPath?: string;
  ref: string;
  status: "checked" | "failed" | "missing" | "unsupported";
};

const SUPPORTED_MODULE_ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".avif",
] as const;

const GENERATED_BITMAP_OCR_EXTENSIONS = [
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".avif",
] as const;

const MODULE_LOCAL_ASSET_DIR = "assets";

const parsePositiveIntegerEnv = (name: string, fallback: number) => {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};

const MODULE_FRAGMENT_CSS_MAX_BYTES = parsePositiveIntegerEnv(
  "MODULE_FRAGMENT_CSS_MAX_BYTES",
  320_000,
);
const MODULE_FRAGMENT_CSS_MAX_GRADIENTS = parsePositiveIntegerEnv(
  "MODULE_FRAGMENT_CSS_MAX_GRADIENTS",
  80,
);
const MODULE_FRAGMENT_CSS_MAX_BOX_SHADOW_LAYERS = parsePositiveIntegerEnv(
  "MODULE_FRAGMENT_CSS_MAX_BOX_SHADOW_LAYERS",
  180,
);
const MODULE_FRAGMENT_CSS_MAX_POLYGON_POINTS = parsePositiveIntegerEnv(
  "MODULE_FRAGMENT_CSS_MAX_POLYGON_POINTS",
  160,
);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const unique = <T>(items: T[]) => [...new Set(items)];

const stripQueryHash = (value: string) => value.split(/[?#]/, 1)[0] ?? value;

const stripFileUrl = (value: string) =>
  value.startsWith("file://") ? value.slice("file://".length) : value;

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

const sanitizeFileName = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";

const cleanReference = (value: string) =>
  stripFileUrl(stripQueryHash(safeDecodeUri(value.trim())));

const normalizeReferenceString = (value: string) =>
  normalizeSlashes(cleanReference(value))
    .replace(/^\.\//, "")
    .replace(/^\/+/, "/")
    .toLowerCase();

const normalizeAbsolutePath = (value: string) =>
  normalizeSlashes(path.resolve(cleanReference(value))).toLowerCase();

const normalizeContentForSearch = (value: string) =>
  normalizeSlashes(safeDecodeUri(value)).toLowerCase();

const getReferenceExtension = (value: string) =>
  path.extname(cleanReference(value)).toLowerCase();

const isSupportedModuleAssetPath = (value: string) =>
  SUPPORTED_MODULE_ASSET_EXTENSIONS.includes(
    getReferenceExtension(
      value,
    ) as (typeof SUPPORTED_MODULE_ASSET_EXTENSIONS)[number],
  );

const isGeneratedBitmapAssetPath = (value: string) =>
  GENERATED_BITMAP_OCR_EXTENSIONS.includes(
    getReferenceExtension(
      value,
    ) as (typeof GENERATED_BITMAP_OCR_EXTENSIONS)[number],
  );

const fileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const isLocalAssetReference = (ref: string) => {
  const clean = cleanReference(ref);
  if (
    !clean ||
    clean.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)
  ) {
    return false;
  }
  return isSupportedModuleAssetPath(clean);
};

const isForbiddenExternalImageReference = (ref: string) => {
  const clean = safeDecodeUri(ref.trim());
  if (/^data:image\//i.test(clean)) return true;
  if (/^(?:https?:)?\/\//i.test(clean)) return true;
  return false;
};

const isAssetReferenceCandidate = (ref: string) =>
  isLocalAssetReference(ref) || isForbiddenExternalImageReference(ref);

const collectMarkupAssetReferences = (content: string, source: string) => {
  const refs: AssetReference[] = [];
  const attrPattern = /\b(?:src|href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
  const urlPattern = /url\(\s*(["']?)([^'")]+)\1\s*\)/gi;

  for (const match of content.matchAll(attrPattern)) {
    const ref = match[2];
    if (ref && isAssetReferenceCandidate(ref)) refs.push({ ref, source });
  }

  for (const match of content.matchAll(urlPattern)) {
    const ref = match[2];
    if (ref && isAssetReferenceCandidate(ref)) refs.push({ ref, source });
  }

  return refs;
};

const collectJsonAssetReferences = (value: unknown, source: string) => {
  const refs: AssetReference[] = [];
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (isRecord(current)) {
      Object.values(current).forEach(visit);
      return;
    }
    if (isString(current) && isLocalAssetReference(current)) {
      refs.push({ ref: current, source });
    }
  };
  visit(value);
  return refs;
};

const buildOriginalSvgRefs = (originalSvgPath?: string) => {
  if (!originalSvgPath) return [];
  const basename = path.basename(originalSvgPath);
  const repoRelative = path.relative(process.cwd(), originalSvgPath);
  return unique(
    [
      basename,
      encodeURIComponent(basename),
      originalSvgPath,
      normalizeSlashes(originalSvgPath),
      repoRelative,
      normalizeSlashes(repoRelative),
      `/${normalizeSlashes(repoRelative)}`,
    ]
      .filter(Boolean)
      .map(normalizeReferenceString),
  );
};

const findOriginalSvgReference = (content: string, originalRefs: string[]) => {
  if (!originalRefs.length) return undefined;
  const normalized = normalizeContentForSearch(content);
  return originalRefs.find((ref) => normalized.includes(ref));
};

const addAllowedReferenceVariants = ({
  absolutePaths,
  baseDirs = [],
  htmlPath,
  rawPath,
  strings,
}: {
  absolutePaths: Set<string>;
  baseDirs?: string[];
  htmlPath?: string;
  rawPath: string;
  strings: Set<string>;
}) => {
  const cleaned = cleanReference(rawPath);
  if (!cleaned || !isSupportedModuleAssetPath(cleaned)) return;

  strings.add(normalizeReferenceString(cleaned));
  strings.add(normalizeReferenceString(cleaned.replace(/^\.\//, "")));

  if (path.isAbsolute(cleaned)) {
    absolutePaths.add(normalizeAbsolutePath(cleaned));
    const repoRelative = normalizeSlashes(
      path.relative(process.cwd(), cleaned),
    );
    if (
      repoRelative &&
      !repoRelative.startsWith("..") &&
      !path.isAbsolute(repoRelative)
    ) {
      strings.add(normalizeReferenceString(repoRelative));
      strings.add(normalizeReferenceString(`/${repoRelative}`));
    }

    if (htmlPath) {
      const relativeFromHtml = normalizeSlashes(
        path.relative(path.dirname(htmlPath), cleaned),
      );
      strings.add(normalizeReferenceString(relativeFromHtml));
      strings.add(normalizeReferenceString(`./${relativeFromHtml}`));
    }
    return;
  }

  for (const baseDir of baseDirs) {
    if (cleaned.startsWith("/")) continue;
    absolutePaths.add(normalizeAbsolutePath(path.resolve(baseDir, cleaned)));
  }

  if (htmlPath && !cleaned.startsWith("/")) {
    absolutePaths.add(
      normalizeAbsolutePath(path.resolve(path.dirname(htmlPath), cleaned)),
    );
  }
};

const getAllowedAssetPathValues = (asset: ModuleOutputAllowedAsset) =>
  [
    asset.svgPath,
    asset.pngPath,
    asset.webpPath,
    asset.jpgPath,
    asset.jpegPath,
    asset.avifPath,
    asset.assetPath,
    asset.path,
    asset.relativePath,
    asset.htmlRef,
    asset.sourcePath,
    asset.url,
  ].filter(isString);

const buildAllowedLookup = ({
  allowedAssets = [],
  baseDirs = [],
  htmlPath,
}: Pick<ModuleOutputPolicy, "allowedAssets" | "htmlPath"> & {
  baseDirs?: string[];
}) => {
  const strings = new Set<string>();
  const absolutePaths = new Set<string>();

  for (const asset of allowedAssets) {
    for (const rawPath of getAllowedAssetPathValues(asset)) {
      addAllowedReferenceVariants({
        absolutePaths,
        baseDirs,
        htmlPath,
        rawPath,
        strings,
      });
    }
  }

  return { absolutePaths, strings };
};

const isAllowedAssetReference = ({
  allowedLookup,
  htmlPath,
  moduleDir,
  ref,
}: {
  allowedLookup: ReturnType<typeof buildAllowedLookup>;
  htmlPath?: string;
  moduleDir?: string;
  ref: string;
}) => {
  const cleaned = cleanReference(ref);
  const normalized = normalizeReferenceString(cleaned);
  if (allowedLookup.strings.has(normalized)) return true;
  if (allowedLookup.strings.has(normalized.replace(/^\.\//, ""))) return true;

  if (path.isAbsolute(cleaned)) {
    return allowedLookup.absolutePaths.has(normalizeAbsolutePath(cleaned));
  }

  if (htmlPath && !cleaned.startsWith("/")) {
    if (
      allowedLookup.absolutePaths.has(
        normalizeAbsolutePath(path.resolve(path.dirname(htmlPath), cleaned)),
      )
    ) {
      return true;
    }
  }

  if (moduleDir && !cleaned.startsWith("/")) {
    return allowedLookup.absolutePaths.has(
      normalizeAbsolutePath(path.resolve(moduleDir, cleaned)),
    );
  }

  return false;
};

const getNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeRegion = (value: unknown): Region | undefined => {
  if (!isRecord(value)) return undefined;
  const x = getNumber(value.x);
  const y = getNumber(value.y);
  const width = getNumber(value.width);
  const height = getNumber(value.height);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { x, y, width, height };
};

const getAssetBox = (asset: ModuleOutputAllowedAsset) =>
  normalizeRegion(asset.box) ??
  normalizeRegion(asset.assetBox) ??
  normalizeRegion(asset.region);

const getGeneratedAssetRef = (asset: ModuleOutputAllowedAsset) =>
  getAllowedAssetPathValues(asset).find(isSupportedModuleAssetPath);

const normalizePathForContainment = (value: string) =>
  normalizeSlashes(path.resolve(value)).toLowerCase();

const isPathInside = (candidate: string, parent: string) => {
  const normalizedCandidate = normalizePathForContainment(candidate);
  const normalizedParent = normalizePathForContainment(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
};

const resolveReferenceCandidates = ({
  htmlPath,
  moduleDir,
  ref,
}: {
  htmlPath?: string;
  moduleDir?: string;
  ref: string;
}) => {
  const cleaned = cleanReference(ref);
  if (!cleaned || cleaned.startsWith("#")) return [];
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned)) return [];
  if (path.isAbsolute(cleaned)) return [path.resolve(cleaned)];

  return unique(
    [
      moduleDir ? path.resolve(moduleDir, cleaned) : undefined,
      htmlPath ? path.resolve(path.dirname(htmlPath), cleaned) : undefined,
    ].filter(isString),
  );
};

const isModuleLocalAssetReference = ({
  htmlPath,
  moduleDir,
  ref,
}: {
  htmlPath?: string;
  moduleDir: string;
  ref: string;
}) => {
  if (!isLocalAssetReference(ref)) return false;
  const assetDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR);
  return resolveReferenceCandidates({ htmlPath, moduleDir, ref }).some(
    (candidate) => isPathInside(candidate, assetDir),
  );
};

const collectGeneratedAssetDeclarations = (
  manifest: unknown,
): GeneratedAssetDeclaration[] => {
  if (!isRecord(manifest)) return [];
  const candidates = [
    manifest.generatedAssets,
    manifest.producedAssets,
    manifest.localAssets,
    manifest.moduleAssets,
  ];
  return candidates.filter(Array.isArray).flatMap((items) =>
    items.filter(isRecord).map((raw) => {
      const asset = raw as ModuleOutputAllowedAsset;
      return {
        box: getAssetBox(asset),
        raw: asset,
        ref: getGeneratedAssetRef(asset),
      } satisfies GeneratedAssetDeclaration;
    }),
  );
};

const flattenOcrResult = (
  ocrResult: OcrResult,
): GeneratedBitmapAssetOcrLine[] =>
  ocrResult.observations.flatMap((observation) =>
    observation.lines.flatMap((line) => {
      const text = line.text.trim();
      if (!text) return [];
      return [
        {
          boundingBox: {
            height: line.boundingBox.height,
            width: line.boundingBox.width,
            x: line.boundingBox.x,
            y: line.boundingBox.y,
          },
          confidence: line.confidence,
          text,
        } satisfies GeneratedBitmapAssetOcrLine,
      ];
    }),
  );

const resolveGeneratedBitmapAssetPath = async ({
  policy,
  ref,
}: {
  policy: ModuleOutputPolicy;
  ref: string;
}) => {
  const assetDir = path.join(policy.moduleDir, MODULE_LOCAL_ASSET_DIR);
  const candidates = resolveReferenceCandidates({
    htmlPath: policy.htmlPath,
    moduleDir: policy.moduleDir,
    ref,
  }).filter((candidate) => isPathInside(candidate, assetDir));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[0];
};

const collectGeneratedBitmapAssetOcr = async ({
  declarations,
  policy,
}: {
  declarations: GeneratedAssetDeclaration[];
  policy: ModuleOutputPolicy;
}): Promise<GeneratedBitmapAssetOcrResult[]> => {
  if (policy.generatedAssetOcr) return policy.generatedAssetOcr;

  const ocrSupport = detectOcrSupport();
  const bitmapDeclarations = declarations.filter(
    (declaration) =>
      declaration.ref !== undefined &&
      isGeneratedBitmapAssetPath(declaration.ref),
  );
  if (!bitmapDeclarations.length) return [];

  const outputDir = path.join(policy.moduleDir, ".policy-ocr");
  await mkdir(outputDir, { recursive: true });

  return Promise.all(
    bitmapDeclarations.map(async (declaration, index) => {
      const ref = declaration.ref!;
      const imagePath = await resolveGeneratedBitmapAssetPath({ policy, ref });
      if (!imagePath || !(await fileExists(imagePath))) {
        return {
          lines: [],
          ref,
          status: "missing",
        } satisfies GeneratedBitmapAssetOcrResult;
      }

      if (!ocrSupport.available) {
        return {
          imagePath,
          lines: [],
          ref,
          status: "unsupported",
        } satisfies GeneratedBitmapAssetOcrResult;
      }

      const outputPath = path.join(
        outputDir,
        `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(path.basename(ref))}.json`,
      );
      try {
        await runOcr({ imagePath, outputPath });
        const result = JSON.parse(
          await readFile(outputPath, "utf8"),
        ) as OcrResult;
        return {
          fullText: result.fullText,
          imagePath,
          lines: flattenOcrResult(result),
          outputPath,
          ref,
          status: "checked",
        } satisfies GeneratedBitmapAssetOcrResult;
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          imagePath,
          lines: [],
          outputPath,
          ref,
          status: "failed",
        } satisfies GeneratedBitmapAssetOcrResult;
      }
    }),
  );
};

const generatedDeclarationsToAllowedAssets = (
  declarations: GeneratedAssetDeclaration[],
) =>
  declarations.map((declaration) => ({
    ...declaration.raw,
    box: declaration.box ?? declaration.raw.box,
    path: declaration.raw.path ?? declaration.ref,
    relativePath: declaration.raw.relativePath ?? declaration.ref,
    source: declaration.raw.source ?? "moduleGenerated",
  }));

const getBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

const normalizeOcrText = (value: string) =>
  value.replace(/\s+/g, "").replace(/[^\p{L}\p{N}]/gu, "");

const isReadableOcrLine = (line: GeneratedBitmapAssetOcrLine) => {
  const normalized = normalizeOcrText(line.text);
  if (!normalized) return false;
  if (line.confidence < 0.35 && normalized.length < 4) return false;
  return normalized.length >= 2 || /[\p{Script=Han}]/u.test(normalized);
};

const getAssetDescriptor = (asset: ModuleOutputAllowedAsset) =>
  [
    asset.assetName,
    asset.name,
    asset.assetRole,
    asset.assetType,
    asset.kind,
    asset.type,
    asset.category,
    asset.source,
    asset.description,
    asset.reason,
    asset.textTreatment,
  ]
    .filter(isString)
    .join(" ")
    .toLowerCase();

const TEXT_SCRUBBING_DESCRIPTOR_RE =
  /\b(?:blurred|scrubbed|redacted|pixel[-_\s]?masked|mosaic(?:ked)?|masked\s+and\s+rebuilt|removed\/masked)\b|(?:文字|文本|ocr|ordinary|label|stat)s?.{0,36}\b(?:blurred|scrubbed|redacted|pixel[-_\s]?masked|mosaic(?:ked)?|masked)\b|(?:模糊|打码|马赛克|遮盖|遮住|抹掉|去除).{0,24}(?:文字|文本|ocr)|(?:文字|文本|ocr).{0,24}(?:模糊|打码|马赛克|遮盖|遮住|抹掉|去除)/i;

const descriptorDeclaresTextScrubbing = (descriptor: string) =>
  TEXT_SCRUBBING_DESCRIPTOR_RE.test(descriptor);

const getTextTreatmentFlags = (asset: ModuleOutputAllowedAsset) => {
  const textTreatment = String(asset.textTreatment ?? "").toLowerCase();
  const declaresNoOrdinaryText =
    /\b(?:no[-_\s]?ordinary[-_\s]?text|no[-_\s]?readable[-_\s]?text|ocr[-_\s]?checked[-_\s]?no[-_\s]?ordinary[-_\s]?text)\b/i.test(
      textTreatment,
    ) ||
    /\b(?:ordinary|video[-_\s]?ui|play|comment|time|metric)s?\b[\s\S]*\b(?:removed|rebuilt|recreated)\b[\s\S]*\bhtml\b/i.test(
      textTreatment,
    );
  const declaresPlainText =
    !declaresNoOrdinaryText &&
    /\b(?:ordinary|plain|body|paragraph|editable|dynamic|html-text|real-text)\b/i.test(
      textTreatment,
    );
  const declaresStylizedText =
    /\b(?:stylized|artistic|intertwined|fused|logo|brand|icon-text|decorative|lettering|cover|thumbnail|artwork|broadcast|atomic-svg-node-visual-text-asset)\b/i.test(
      textTreatment,
    );

  return { declaresNoOrdinaryText, declaresPlainText, declaresStylizedText };
};

const intersectsArea = (left: Region, right: Region) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

const getModuleCoverage = (assetBox: Region, moduleRegion?: Region) => {
  if (!moduleRegion) return undefined;
  const moduleArea = Math.max(1, moduleRegion.width * moduleRegion.height);
  return intersectsArea(assetBox, moduleRegion) / moduleArea;
};

const collectGeneratedAssetIssues = async ({
  declarations,
  policy,
}: {
  declarations: GeneratedAssetDeclaration[];
  policy: ModuleOutputPolicy;
}) => {
  const issues: string[] = [];
  const assetDir = path.join(policy.moduleDir, MODULE_LOCAL_ASSET_DIR);

  for (const [index, declaration] of declarations.entries()) {
    const label =
      declaration.raw.assetName ??
      declaration.raw.name ??
      declaration.raw.assetId ??
      `generatedAssets[${index}]`;
    const ref = declaration.ref;
    if (!ref) {
      issues.push(
        `${policy.moduleId}: manifest.generatedAssets[${index}] must declare a local asset path/ref`,
      );
      continue;
    }

    if (!isSupportedModuleAssetPath(ref)) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" uses unsupported file type: ${ref}`,
      );
    }

    if (
      !resolveReferenceCandidates({
        htmlPath: policy.htmlPath,
        moduleDir: policy.moduleDir,
        ref,
      }).some((candidate) => isPathInside(candidate, assetDir))
    ) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" must live under ${MODULE_LOCAL_ASSET_DIR}/ inside the module directory: ${ref}`,
      );
    }

    const assetPath = await resolveGeneratedBitmapAssetPath({ policy, ref });
    if (!assetPath || !(await fileExists(assetPath))) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" is declared in manifest.generatedAssets but the file does not exist: ${ref}`,
      );
    }

    const box = declaration.box;
    if (!box) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" must include absolute position box metadata for OCR/layout review`,
      );
    }

    const descriptor = getAssetDescriptor(declaration.raw);
    const declaresAtomicSvgNodeVisualText =
      /\b(?:atomic-svg-node-visual-text-asset|single[-_\s]?svg[-_\s]?node|module[-_\s]?svg[-_\s]?embedded[-_\s]?image|module[-_\s]?svg[-_\s]?node|embedded[-_\s]?image|cover|thumbnail|logo|icon)\b/i.test(
        descriptor,
      );
    if (descriptorDeclaresTextScrubbing(descriptor)) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" declares ordinary text was blurred/scrubbed/masked before reuse; do not use redacted or mosaic text assets. Crop a clean visual asset, split the shell into CSS/HTML, or keep the whole readable text as real DOM.`,
      );
    }

    const containsText =
      getBoolean(declaration.raw.containsText) ??
      getBoolean(declaration.raw.hasText) ??
      getBoolean(declaration.raw.ocrTextDetected);
    const { declaresPlainText, declaresStylizedText } = getTextTreatmentFlags(
      declaration.raw,
    );
    if (
      (containsText || declaresPlainText) &&
      !declaresStylizedText &&
      !declaresAtomicSvgNodeVisualText
    ) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" appears to contain ordinary readable text; use HTML text unless the text is stylized/intertwined and declare textTreatment`,
      );
    }

    if (ref && isGeneratedBitmapAssetPath(ref)) {
      const ocrResult = policy.generatedAssetOcr?.find(
        (result) =>
          normalizeReferenceString(result.ref) ===
          normalizeReferenceString(ref),
      );
      if (!ocrResult) {
        issues.push(
          `${policy.moduleId}: generated bitmap asset "${label}" must be OCR-checked before it can be accepted: ${ref}`,
        );
      } else if (ocrResult.status !== "checked") {
        issues.push(
          `${policy.moduleId}: generated bitmap asset "${label}" OCR ${ocrResult.status}${ocrResult.error ? ` (${ocrResult.error})` : ""}: ${ref}`,
        );
      } else {
        const readableLines = ocrResult.lines.filter(isReadableOcrLine);
        if (
          readableLines.length &&
          !declaresStylizedText &&
          !declaresAtomicSvgNodeVisualText
        ) {
          const sample = readableLines
            .slice(0, 3)
            .map((line) => line.text.trim())
            .join(" / ");
          issues.push(
            `${policy.moduleId}: generated bitmap asset "${label}" OCR detected readable text "${sample}"; ordinary text must be HTML unless textTreatment declares stylized/intertwined/logo`,
          );
        }
      }
    }

    const coverage = box
      ? getModuleCoverage(box, policy.moduleRegion)
      : undefined;
    const hasLargeAssetIntent =
      /\b(?:photo|raster|bitmap|image|texture|illustration|cover|pattern|background|backdrop|underlay|logo|icon|visual-asset)\b/i.test(
        descriptor,
      );
    if (coverage !== undefined && coverage >= 0.92 && !hasLargeAssetIntent) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" covers ${(coverage * 100).toFixed(1)}% of the module without a concrete visual asset role; avoid whole-module image fallback`,
      );
    }
  }

  return issues;
};

const collectForbiddenStrategyIssues = ({
  manifest,
  moduleId,
}: {
  manifest: unknown;
  moduleId: string;
}) => {
  const issues: string[] = [];
  const forbiddenStrategyPattern =
    /\b(?:svg[-_\s]?crop|module[-_\s]?crop|page[-_\s]?crop|whole[-_\s]?svg|full[-_\s]?(?:page|svg|image|module)|original[-_\s]?svg)\b/i;

  const visit = (value: unknown, keyPath: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${keyPath}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;

    Object.entries(value).forEach(([key, child]) => {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      const normalizedKey = key
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replaceAll("_", "-")
        .toLowerCase();
      if (
        isString(child) &&
        (normalizedKey.includes("strategy") ||
          normalizedKey.includes("mode")) &&
        forbiddenStrategyPattern.test(child)
      ) {
        issues.push(
          `${moduleId}: manifest.${childPath} declares forbidden whole-SVG strategy "${child}"`,
        );
      }
      visit(child, childPath);
    });
  };

  visit(manifest, "");
  return issues;
};

const collectInlineSvgIssues = ({
  fragmentHtml,
  moduleId,
}: {
  fragmentHtml: string;
  moduleId: string;
}) =>
  /<svg\b/i.test(fragmentHtml)
    ? [
        `${moduleId}: fragment.html contains inline <svg>; final render integrity forbids inline SVG, so use CSS/HTML shapes or write a bounded local asset file and reference it`,
      ]
    : [];

const collectDataImageIssues = ({
  moduleId,
  sources,
}: {
  moduleId: string;
  sources: ReadonlyArray<readonly [string, string]>;
}) =>
  sources.flatMap(([label, content]) =>
    /data:image\//i.test(content)
      ? [
          `${moduleId}: ${label} embeds data:image content; write bounded local assets under the module assets directory instead of base64/data URI fallback`,
        ]
      : [],
  );

const splitTopLevelCssList = (value: string) => {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) items.push(tail);
  return items;
};

const countCssBoxShadowLayers = (css: string) => {
  let layers = 0;
  for (const match of css.matchAll(/box-shadow\s*:\s*([^;}]+)/gi)) {
    const value = match[1] ?? "";
    if (!value || /\bnone\b/i.test(value)) continue;
    layers += splitTopLevelCssList(value).length;
  }
  return layers;
};

const countCssPolygonPoints = (css: string) => {
  let points = 0;
  for (const match of css.matchAll(/clip-path\s*:\s*polygon\(([^)]*)\)/gi)) {
    points += splitTopLevelCssList(match[1] ?? "").length;
  }
  return points;
};

const collectFullBleedGradientBlocks = (css: string) => {
  const issues: string[] = [];
  const rulePattern = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
    const body = match[2] ?? "";
    if (
      !selector ||
      !/(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(body)
    ) {
      continue;
    }
    const fullBleed =
      /(?:^|;)\s*inset\s*:\s*0(?:px)?\s*(?:!important)?\s*(?:;|$)/i.test(
        body,
      ) ||
      (/(?:^|;)\s*width\s*:\s*100%\s*(?:!important)?\s*(?:;|$)/i.test(body) &&
        /(?:^|;)\s*height\s*:\s*100%\s*(?:!important)?\s*(?:;|$)/i.test(body));
    const visualLayer =
      /\b(?:bg|background|backdrop|shell|art|cover|poster|image|visual|mask|mosaic)\b/i.test(
        selector,
      );
    if (fullBleed && visualLayer) issues.push(selector);
  }
  return unique(issues).slice(0, 5);
};

const collectCssComplexDrawingIssues = ({
  fragmentCss,
  moduleId,
}: {
  fragmentCss: string;
  moduleId: string;
}) => {
  const issues: string[] = [];
  const cssBytes = Buffer.byteLength(fragmentCss, "utf8");
  const gradientCount =
    fragmentCss.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi)
      ?.length ?? 0;
  const boxShadowLayers = countCssBoxShadowLayers(fragmentCss);
  const polygonPoints = countCssPolygonPoints(fragmentCss);

  if (cssBytes > MODULE_FRAGMENT_CSS_MAX_BYTES) {
    issues.push(
      `${moduleId}: fragment.css is ${cssBytes.toLocaleString("en-US")} bytes; this usually means CSS is drawing complex bitmap/vector art instead of using bounded local assets`,
    );
  }
  if (gradientCount > MODULE_FRAGMENT_CSS_MAX_GRADIENTS) {
    issues.push(
      `${moduleId}: fragment.css uses ${gradientCount} CSS gradients; use bitmap/vector assets for complex visual texture/cover art instead of gradient mosaics`,
    );
  }
  if (boxShadowLayers > MODULE_FRAGMENT_CSS_MAX_BOX_SHADOW_LAYERS) {
    issues.push(
      `${moduleId}: fragment.css uses ${boxShadowLayers} box-shadow layers; do not recreate images as CSS pixel/mosaic layers`,
    );
  }
  if (polygonPoints > MODULE_FRAGMENT_CSS_MAX_POLYGON_POINTS) {
    issues.push(
      `${moduleId}: fragment.css uses ${polygonPoints} clip-path polygon points; use a bounded vector/raster asset for complex silhouettes`,
    );
  }

  const fullBleedGradientBlocks = collectFullBleedGradientBlocks(fragmentCss);
  if (fullBleedGradientBlocks.length) {
    issues.push(
      `${moduleId}: fragment.css has full-bleed gradient visual layers (${fullBleedGradientBlocks.join(", ")}); avoid whole-module CSS background approximation`,
    );
  }

  return issues;
};

const collectModuleOutputPolicyIssues = async (
  payload: ModuleOutputPayload,
  policy: ModuleOutputPolicy,
) => {
  const issues: string[] = [];
  const originalSvgPath = policy.originalSvgPath ?? policy.design?.svgPath;
  const originalRefs = buildOriginalSvgRefs(originalSvgPath);
  const sources = [
    ["fragment.html", payload.fragmentHtml],
    ["fragment.css", payload.fragmentCss],
    ["text-layout.json", payload.textLayoutRaw],
    ["manifest.json", payload.manifestRaw],
  ] as const;

  for (const [label, content] of sources) {
    const originalRef = findOriginalSvgReference(content, originalRefs);
    if (originalRef) {
      issues.push(
        `${policy.moduleId}: ${label} references the original whole SVG (${originalRef})`,
      );
    }
  }

  issues.push(
    ...collectDataImageIssues({
      moduleId: policy.moduleId,
      sources,
    }),
  );
  issues.push(
    ...collectCssComplexDrawingIssues({
      fragmentCss: payload.fragmentCss,
      moduleId: policy.moduleId,
    }),
  );
  issues.push(
    ...collectForbiddenStrategyIssues({
      manifest: payload.manifest,
      moduleId: policy.moduleId,
    }),
  );
  issues.push(
    ...collectInlineSvgIssues({
      fragmentHtml: payload.fragmentHtml,
      moduleId: policy.moduleId,
    }),
  );

  const generatedAssetDeclarations = collectGeneratedAssetDeclarations(
    payload.manifest,
  );
  const generatedAssetOcr = await collectGeneratedBitmapAssetOcr({
    declarations: generatedAssetDeclarations,
    policy,
  });
  issues.push(
    ...(await collectGeneratedAssetIssues({
      declarations: generatedAssetDeclarations,
      policy: { ...policy, generatedAssetOcr },
    })),
  );
  const policyAllowedAssets = [
    ...(policy.allowedAssets ?? []),
    ...generatedDeclarationsToAllowedAssets(generatedAssetDeclarations),
  ];
  const allowedLookup = buildAllowedLookup({
    allowedAssets: policyAllowedAssets,
    baseDirs: [policy.moduleDir],
    htmlPath: policy.htmlPath,
  });
  const refs = [
    ...collectMarkupAssetReferences(payload.fragmentHtml, "fragment.html"),
    ...collectMarkupAssetReferences(payload.fragmentCss, "fragment.css"),
    ...collectJsonAssetReferences(payload.manifest, "manifest.json"),
  ];
  const mustUseAssets = (policy.allowedAssets ?? []).filter(
    (asset) => asset.mustUse === true,
  );
  for (const asset of mustUseAssets) {
    const assetLookup = buildAllowedLookup({
      allowedAssets: [asset],
      baseDirs: [policy.moduleDir],
      htmlPath: policy.htmlPath,
    });
    const used = refs.some((ref) =>
      isAllowedAssetReference({
        allowedLookup: assetLookup,
        htmlPath: policy.htmlPath,
        moduleDir: policy.moduleDir,
        ref: ref.ref,
      }),
    );
    if (!used) {
      const label =
        asset.assetName ??
        asset.name ??
        asset.path ??
        "asset";
      issues.push(
        `${policy.moduleId}: must-use asset "${label}" from allowed-assets.json was not referenced`,
      );
    }
  }
  const seenRefs = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.source}:${normalizeReferenceString(ref.ref)}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    if (
      isAllowedAssetReference({
        allowedLookup,
        htmlPath: policy.htmlPath,
        moduleDir: policy.moduleDir,
        ref: ref.ref,
      })
    ) {
      continue;
    }
    if (
      isModuleLocalAssetReference({
        htmlPath: policy.htmlPath,
        moduleDir: policy.moduleDir,
        ref: ref.ref,
      })
    ) {
      issues.push(
        `${policy.moduleId}: ${ref.source} references module-local asset not declared in manifest.generatedAssets: ${ref.ref}`,
      );
      continue;
    }
    issues.push(
      `${policy.moduleId}: ${ref.source} references local asset outside allowed-assets.json/generatedAssets: ${ref.ref}`,
    );
  }

  return issues;
};

const isGeneratedAssetReadableTextPolicyIssue = (issue: string) =>
  /generated (?:bitmap )?asset .*(?:appears to contain ordinary readable text|OCR detected readable text)/i.test(
    issue,
  );

const assertModuleOutputPolicy = async (
  payload: ModuleOutputPayload,
  policy: ModuleOutputPolicy,
) => {
  const issues = await collectModuleOutputPolicyIssues(payload, policy);
  const hardIssues = issues.filter(
    (issue) => !isGeneratedAssetReadableTextPolicyIssue(issue),
  );
  if (!hardIssues.length) return;
  throw new Error(
    `Module output violates isolation policy:\n${hardIssues.join("\n")}`,
  );
};

export type {
  ModuleOutputAllowedAsset,
  ModuleOutputDesign,
  GeneratedBitmapAssetOcrResult,
  ModuleOutputPayload,
  ModuleOutputPolicy,
};
export {
  MODULE_LOCAL_ASSET_DIR,
  SUPPORTED_MODULE_ASSET_EXTENSIONS,
  assertModuleOutputPolicy,
  collectModuleOutputPolicyIssues,
  isGeneratedAssetReadableTextPolicyIssue,
  isSupportedModuleAssetPath,
};
