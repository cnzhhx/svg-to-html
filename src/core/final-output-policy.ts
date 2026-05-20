import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists, safeDecodeUri } from "./io.js";
import { normalizeAssetMetadata } from "./asset-metadata.js";
import {
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  writeJsonFile,
  writeTextFile,
  type DesignPair,
} from "./utils.js";
import { collectHtmlIntegrityIssues } from "./render.js";

type AssetManifestEntry = {
  assetName?: string;
  assetPath?: string;
  assetRole?: string;
  category?: string;
  containsIntrinsicText?: boolean;
  containsText?: boolean;
  description?: string;
  htmlRef?: string;
  height?: number;
  mustUse?: boolean;
  name?: string;
  path?: string;
  pngPath?: string;
  relativePath?: string;
  source?: string;
  sourcePath?: string;
  textTreatment?: string;
  svgPath?: string;
  url?: string;
  width?: number;
  [key: string]: unknown;
};

type SvgReference = {
  ref: string;
  source: string;
};

type SvgDimensions = {
  height: number;
  width: number;
};

type FinalOutputPolicyIssue = {
  assetPath?: string;
  dimensions?: SvgDimensions;
  kind:
    | "hidden-semantic-dom"
    | "html-integrity"
    | "blocked-visual-asset-risk"
    | "local-asset-readable-text"
    | "layout-asset-visual-layer"
    | "large-raster-visual-layer"
    | "large-untracked-svg-layer"
    | "local-asset-missing"
    | "local-asset-text-scrubbed"
    | "must-use-asset-missing"
    | "original-render-image-reference"
    | "original-svg-reference"
    | "suspicious-original-crop";
  ref?: string;
  selector?: string;
  severity: "error" | "warning";
  summary: string;
};

type FinalOutputPolicyReport = {
  criticalIssueCount: number;
  designName: string;
  issueCount: number;
  issues: FinalOutputPolicyIssue[];
  passed: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanReference = (value: string) =>
  safeDecodeUri(value.trim())
    .split(/[?#]/, 1)[0]
    ?.replace(/^file:\/\//, "") ?? "";

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

const normalizePathKey = (value: string) =>
  normalizeSlashes(path.resolve(cleanReference(value))).toLowerCase();

const parseNumber = (value: string | undefined) => {
  if (!value) return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getAttr = (attrs: string, name: string) => {
  const match = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const fileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const SUPPORTED_LOCAL_ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".avif",
] as const;

const readArtifactShellManifest = async (artifactDir: string) => {
  const parsed = await readJsonIfExists<unknown>(
    path.join(artifactDir, "shell-manifest.json"),
  );
  if (Array.isArray(parsed))
    return parsed.filter(isRecord) as AssetManifestEntry[];
  if (isRecord(parsed) && Array.isArray(parsed["entries"])) {
    return parsed["entries"].filter(isRecord) as AssetManifestEntry[];
  }
  return [];
};

const readAllAssetManifestEntries = async ({
  artifactDir,
}: {
  artifactDir: string;
}) => {
  const sharedLayers = await readJsonIfExists<unknown>(
    path.join(artifactDir, "modules", "shared-layers.json"),
  );
  const sharedLayerEntries = Array.isArray(sharedLayers)
    ? (sharedLayers.filter(isRecord) as AssetManifestEntry[])
    : [];
  return [...(await readArtifactShellManifest(artifactDir)), ...sharedLayerEntries];
};

const getAssetMetadataRefValues = (entry: AssetManifestEntry) =>
  [
    entry.assetPath,
    entry.svgPath,
    entry.pngPath,
    entry.path,
    entry.relativePath,
    entry.htmlRef,
    entry.sourcePath,
    entry.url,
  ].filter((value): value is string => typeof value === "string");

const mergeAssetMetadata = (
  base: AssetManifestEntry | undefined,
  next: AssetManifestEntry,
) => ({
  ...(base ?? {}),
  ...next,
  description: [base?.description, next.description]
    .filter(Boolean)
    .join(" | "),
  reason: [base?.reason, next.reason].filter(Boolean).join(" | "),
});

const addMetadataEntry = ({
  byBasename,
  byPath,
  entry,
  htmlDir,
  moduleDir,
}: {
  byBasename: Map<string, AssetManifestEntry>;
  byPath: Map<string, AssetManifestEntry>;
  entry: AssetManifestEntry;
  htmlDir: string;
  moduleDir?: string;
}) => {
  const names = [entry.name, entry.assetName].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const name of names) {
    byBasename.set(name, mergeAssetMetadata(byBasename.get(name), entry));
  }

  for (const rawRef of getAssetMetadataRefValues(entry)) {
    const clean = cleanReference(rawRef);
    if (
      !clean ||
      clean.startsWith("#") ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)
    ) {
      continue;
    }

    const candidates = path.isAbsolute(clean)
      ? [
          path.resolve(clean),
          path.resolve(process.cwd(), clean.replace(/^\/+/, "")),
        ]
      : [
          moduleDir ? path.resolve(moduleDir, clean) : undefined,
          path.resolve(htmlDir, clean),
        ].filter((value): value is string => typeof value === "string");

    for (const candidate of candidates) {
      byPath.set(
        normalizePathKey(candidate),
        mergeAssetMetadata(byPath.get(normalizePathKey(candidate)), entry),
      );
      byBasename.set(
        path.basename(candidate).replace(/\.(?:svg|png|webp|jpe?g|avif)$/i, ""),
        mergeAssetMetadata(
          byBasename.get(
            path
              .basename(candidate)
              .replace(/\.(?:svg|png|webp|jpe?g|avif)$/i, ""),
          ),
          entry,
        ),
      );
    }
  }
};

const collectGeneratedAssetEntries = (
  manifest: unknown,
): AssetManifestEntry[] => {
  if (!isRecord(manifest)) return [];
  return [
    "generatedAssets",
    "producedAssets",
    "localAssets",
    "moduleAssets",
  ].flatMap((key) => {
    const collection = manifest[key];
    if (!Array.isArray(collection)) return [];
    return collection.filter(isRecord) as AssetManifestEntry[];
  });
};

const createAssetMetadataLookup = async (
  design: DesignPair,
  extraEntries: AssetManifestEntry[] = [],
) => {
  const htmlDir = path.dirname(design.htmlPath);
  const byBasename = new Map<string, AssetManifestEntry>();
  const byPath = new Map<string, AssetManifestEntry>();

  for (const entry of extraEntries) {
    addMetadataEntry({ byBasename, byPath, entry, htmlDir });
  }

  const modulesDir = path.join(htmlDir, "artifacts", "modules");
  try {
    const moduleDirs = await readdir(modulesDir, { withFileTypes: true });
    for (const dirent of moduleDirs) {
      if (!dirent.isDirectory() || !/^module-/.test(dirent.name)) continue;
      const moduleDir = path.join(modulesDir, dirent.name);
      const manifest = await readJsonIfExists<unknown>(
        path.join(moduleDir, "manifest.json"),
      );
      for (const generatedEntry of collectGeneratedAssetEntries(manifest)) {
        addMetadataEntry({
          byBasename,
          byPath,
          entry: generatedEntry,
          htmlDir,
          moduleDir,
        });
      }
    }
  } catch {
    // Module manifests are optional for non-module sessions.
  }

  return { byBasename, byPath };
};

const isSupportedLocalAssetReference = (ref: string) =>
  SUPPORTED_LOCAL_ASSET_EXTENSIONS.includes(
    path
      .extname(cleanReference(ref))
      .toLowerCase() as (typeof SUPPORTED_LOCAL_ASSET_EXTENSIONS)[number],
  );

const getAssetMetadataDescriptor = (entry: AssetManifestEntry) =>
  [
    entry.assetName,
    entry.name,
    entry.category,
    entry.source,
    entry.description,
    entry.reason,
    entry.textTreatment,
    entry.assetRole,
    entry.assetType,
    entry.kind,
    entry.type,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

const TEXT_SCRUBBING_DESCRIPTOR_RE =
  /\b(?:blurred|scrubbed|redacted|pixel[-_\s]?masked|mosaic(?:ked)?|masked\s+and\s+rebuilt|removed\/masked)\b|(?:文字|文本|ocr|ordinary|label|stat)s?.{0,36}\b(?:blurred|scrubbed|redacted|pixel[-_\s]?masked|mosaic(?:ked)?|masked)\b|(?:模糊|打码|马赛克|遮盖|遮住|抹掉|去除).{0,24}(?:文字|文本|ocr)|(?:文字|文本|ocr).{0,24}(?:模糊|打码|马赛克|遮盖|遮住|抹掉|去除)/i;

const READABLE_TEXT_DESCRIPTOR_RE =
  /(?:ordinary[-_\s]?readable[-_\s]?text|plain[-_\s]?text|text[-_\s]?path|text\s+converted\s+to\s+path|文字路径|文本路径|文字转路径|路径文字|白色文字|灰色文字|黑色文字|普通文字|可读文字|带[^。；;]*文字|数字或短文字|短文字的路径|文字\/图标)/i;

const STYLIZED_TEXT_DESCRIPTOR_RE =
  /\b(?:stylized|artistic|intertwined|fused|logo|brand|decorative|lettering|cover|thumbnail|artwork)\b|(?:艺术字|品牌|标志|装饰字|封面字形|交织)/i;

const descriptorDeclaresTextScrubbing = (descriptor: string) =>
  TEXT_SCRUBBING_DESCRIPTOR_RE.test(descriptor);

const descriptorDeclaresReadableText = (descriptor: string) =>
  READABLE_TEXT_DESCRIPTOR_RE.test(descriptor);

const descriptorDeclaresStylizedText = (descriptor: string) =>
  STYLIZED_TEXT_DESCRIPTOR_RE.test(descriptor);

const collectAssetReferences = (html: string) => {
  const refs: SvgReference[] = [];
  const attrPattern = /\b(?:src|href|xlink:href)\s*=\s*(["'])(.*?)\1/gi;
  const srcsetPattern = /\b(?:srcset|imagesrcset)\s*=\s*(["'])(.*?)\1/gi;
  const urlPattern = /url\(\s*(["']?)([^'")]+)\1\s*\)/gi;

  for (const match of html.matchAll(attrPattern)) {
    const ref = match[2];
    if (ref && isSupportedLocalAssetReference(ref)) {
      refs.push({ ref, source: "html-attribute" });
    }
  }

  for (const match of html.matchAll(srcsetPattern)) {
    const srcset = match[2] ?? "";
    for (const candidate of srcset.split(",")) {
      const ref = candidate.trim().split(/\s+/, 1)[0];
      if (ref && isSupportedLocalAssetReference(ref)) {
        refs.push({ ref, source: "html-srcset" });
      }
    }
  }

  for (const match of html.matchAll(urlPattern)) {
    const ref = match[2];
    if (ref && isSupportedLocalAssetReference(ref)) {
      refs.push({ ref, source: "css-url" });
    }
  }

  return refs;
};

const resolveReferenceCandidates = (ref: string, htmlDir: string) => {
  const clean = cleanReference(ref);
  if (
    !clean ||
    clean.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)
  ) {
    return [];
  }
  const candidates = path.isAbsolute(clean)
    ? [
        path.resolve(clean),
        path.resolve(process.cwd(), clean.replace(/^\/+/, "")),
      ]
    : [path.resolve(htmlDir, clean)];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
};

const resolveExistingReferencePath = async (ref: string, htmlDir: string) => {
  for (const candidate of resolveReferenceCandidates(ref, htmlDir)) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
};

const readSvgDimensions = async (
  svgPath: string,
): Promise<SvgDimensions | null> => {
  try {
    const svg = await readFile(svgPath, "utf8");
    const open = svg.match(/<svg\b([^>]*)>/i);
    if (!open) return null;
    const attrs = open[1] ?? "";
    const width = parseNumber(getAttr(attrs, "width"));
    const height = parseNumber(getAttr(attrs, "height"));
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { height: height!, width: width! };
    }

    const viewBox = getAttr(attrs, "viewBox");
    const numbers = viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    if (numbers && numbers.length >= 4) {
      return { height: numbers[3]!, width: numbers[2]! };
    }
  } catch {
    return null;
  }
  return null;
};

const readPngDimensions = (buffer: Buffer): SvgDimensions | null => {
  if (
    buffer.length < 24 ||
    buffer.toString("ascii", 1, 4) !== "PNG" ||
    buffer.readUInt32BE(12) !== 0x49484452
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { height, width } : null;
};

const readJpegDimensions = (buffer: Buffer): SvgDimensions | null => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { height, width } : null;
    }
    offset += 2 + length;
  }
  return null;
};

const readRasterDimensions = async (
  assetPath: string,
): Promise<SvgDimensions | null> => {
  try {
    const buffer = await readFile(assetPath);
    const ext = path.extname(assetPath).toLowerCase();
    if (ext === ".png") return readPngDimensions(buffer);
    if (ext === ".jpg" || ext === ".jpeg") return readJpegDimensions(buffer);
  } catch {
    return null;
  }
  return null;
};

const createManifestLookup = ({
  entries,
  htmlDir,
}: {
  entries: AssetManifestEntry[];
  htmlDir: string;
}) => {
  const byBasename = new Map<string, AssetManifestEntry>();
  const byPath = new Map<string, AssetManifestEntry>();
  for (const entry of entries) {
    addMetadataEntry({ byBasename, byPath, entry, htmlDir });
  }
  return byPath;
};

const isMustUseAsset = (entry: AssetManifestEntry) => entry.mustUse === true;

const getEntryDimensions = async (
  entry: AssetManifestEntry | undefined,
  assetPath: string,
) => {
  const width = Number(entry?.width);
  const height = Number(entry?.height);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return { height, width };
  }
  return /\.svg$/i.test(assetPath)
    ? readSvgDimensions(assetPath)
    : readRasterDimensions(assetPath);
};

const isLargeVisualLayer = ({
  design,
  dimensions,
}: {
  design: DesignPair;
  dimensions: SvgDimensions;
}) => {
  const designArea = Math.max(1, design.width * design.height);
  const assetArea = dimensions.width * dimensions.height;
  const fullWidthTall =
    dimensions.width >= design.width * 0.88 &&
    dimensions.height >= design.height * 0.24;
  const mostlyFullPage =
    dimensions.width >= design.width * 0.72 &&
    dimensions.height >= design.height * 0.72;
  const areaDominates = assetArea >= designArea * 0.36;
  return fullWidthTall || mostlyFullPage || areaDominates;
};

const isManifestNoTextBackground = (entry: AssetManifestEntry | undefined) => {
  if (!entry) return false;
  if (entry.containsText === true || entry.containsIntrinsicText === true)
    return false;
  const treatment = entry.textTreatment?.toLowerCase() ?? "";
  const category = entry.category?.toLowerCase() ?? "";
  const hasNoTextSignal =
    entry.containsText === false ||
    entry.containsIntrinsicText === false ||
    /(?:no[-_\s]?ordinary[-_\s]?text|no[-_\s]?text|ocr-checked-no-ordinary-text)/i.test(
      treatment,
    );
  if (!hasNoTextSignal) return false;
  return category !== "text";
};

const isSuspiciousOriginalName = (value: string) =>
  /(?:^|[-_/])(original|whole|full[-_]?page|full[-_]?svg|svg[-_]?crop|page[-_]?crop)(?:[-_. /]|$)/i.test(
    value,
  );

const buildOriginalSvgRefs = (design: DesignPair) => {
  const basename = path.basename(design.svgPath);
  const repoRelative = path.relative(process.cwd(), design.svgPath);
  return new Set(
    [
      basename,
      encodeURIComponent(basename),
      design.svgPath,
      normalizeSlashes(design.svgPath),
      repoRelative,
      normalizeSlashes(repoRelative),
      `/${normalizeSlashes(repoRelative)}`,
    ].map((item) => normalizeSlashes(safeDecodeUri(item)).toLowerCase()),
  );
};

const isOriginalRenderImagePath = ({
  artifactDir,
  assetPath,
}: {
  artifactDir: string;
  assetPath: string;
}) => {
  const normalizedAsset = normalizePathKey(assetPath);
  const normalizedArtifact = normalizePathKey(artifactDir);
  if (!normalizedAsset.startsWith(`${normalizedArtifact}/`)) return false;
  return /(?:^|\/)(?:svg|render-svg|source-svg|original|original-render)\.(?:png|jpe?g|webp)$/i.test(
    normalizeSlashes(assetPath),
  );
};

const collectOriginalSvgReferenceIssues = ({
  design,
  html,
}: {
  design: DesignPair;
  html: string;
}): FinalOutputPolicyIssue[] => {
  const originalRefs = buildOriginalSvgRefs(design);
  const normalizedHtml = normalizeSlashes(safeDecodeUri(html)).toLowerCase();
  const matched = [...originalRefs].find((ref) => normalizedHtml.includes(ref));
  if (!matched) return [];
  return [
    {
      kind: "original-svg-reference",
      ref: matched,
      severity: "error",
      summary:
        "最终 HTML 引用了原始设计 SVG。最终还原页不能把整张原始 SVG 作为视觉层或资源 fallback。",
    } satisfies FinalOutputPolicyIssue,
  ];
};

const collectLargeVisualLayerIssues = async ({
  artifactDir,
  design,
  html,
  manifestEntries,
}: {
  artifactDir: string;
  design: DesignPair;
  html: string;
  manifestEntries: AssetManifestEntry[];
}) => {
  const htmlDir = path.dirname(design.htmlPath);
  const manifestByPath = createManifestLookup({
    entries: manifestEntries,
    htmlDir,
  });
  const issues: FinalOutputPolicyIssue[] = [];
  const seen = new Set<string>();

  for (const reference of collectAssetReferences(html)) {
    const assetPath = await resolveExistingReferencePath(
      reference.ref,
      htmlDir,
    );
    if (!assetPath || seen.has(assetPath)) continue;
    seen.add(assetPath);
    if (normalizePathKey(assetPath) === normalizePathKey(design.svgPath)) {
      issues.push({
        assetPath,
        kind: "original-svg-reference",
        ref: reference.ref,
        severity: "error",
        summary: "最终 HTML 直接引用原始设计 SVG。",
      });
      continue;
    }

    const entry = manifestByPath.get(normalizePathKey(assetPath));
    const dimensions = await getEntryDimensions(entry, assetPath);
    if (!dimensions) continue;

    const large = isLargeVisualLayer({ design, dimensions });
    const category = entry?.category?.toLowerCase();
    const assetLabel = entry?.name ?? path.basename(assetPath);
    const mustUseAsset = entry ? isMustUseAsset(entry) : false;
    const normalizedMetadata = entry
      ? normalizeAssetMetadata({
          assetBox: {
            height: dimensions.height,
            width: dimensions.width,
            x: 0,
            y: 0,
          },
          designRegion: {
            height: design.height,
            width: design.width,
            x: 0,
            y: 0,
          },
          entry,
        })
      : undefined;

    const allowLargeBackgroundUnderlay =
      mustUseAsset ||
      normalizedMetadata?.recommendedUse === "background-underlay-only" ||
      isManifestNoTextBackground(entry);

    if (normalizedMetadata?.riskLevel === "blocked") {
      issues.push({
        assetPath,
        dimensions,
        kind: "blocked-visual-asset-risk",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了风险被阻断的视觉资源 "${assetLabel}"：${normalizedMetadata.riskReasons.join("；") || "缺少安全 metadata"}。`,
      });
      continue;
    }

    if (
      large &&
      isOriginalRenderImagePath({ artifactDir, assetPath }) &&
      !allowLargeBackgroundUnderlay
    ) {
      issues.push({
        assetPath,
        dimensions,
        kind: "original-render-image-reference",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了原始设计渲染图 "${path.basename(assetPath)}"。不能把整张 SVG/PNG 渲染结果作为最终背景替代真实 DOM。`,
      });
      continue;
    }

    if (large && category === "layout" && !allowLargeBackgroundUnderlay) {
      issues.push({
        assetPath,
        dimensions,
        kind: "layout-asset-visual-layer",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了大尺寸 layout SVG 资源 "${assetLabel}"。layout/page shell 只能作为预处理参考，不能作为最终视觉层覆盖页面。`,
      });
      continue;
    }

    if (
      large &&
      !allowLargeBackgroundUnderlay &&
      isSuspiciousOriginalName(`${reference.ref} ${assetPath} ${assetLabel}`)
    ) {
      issues.push({
        assetPath,
        dimensions,
        kind: "suspicious-original-crop",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了疑似原始大图裁剪 "${path.basename(assetPath)}"。请拆成真实 HTML/CSS、明确无文本的底层背景，或边界清晰的小型无文本资源。`,
      });
      continue;
    }

    if (large && !entry) {
      const isSvg = /\.svg$/i.test(assetPath);
      issues.push({
        assetPath,
        dimensions,
        kind: isSvg ? "large-untracked-svg-layer" : "large-raster-visual-layer",
        ref: reference.ref,
        severity: "warning",
        summary: `最终 HTML 引用了未登记的大尺寸${isSvg ? " SVG" : "栅格图"}资源 "${path.basename(assetPath)}"。若它不是无文本的背景 underlay 或局部装饰，应拆回真实结构。`,
      });
    }
  }

  return issues;
};

const collectMissingLocalAssetIssues = async ({
  design,
  html,
}: {
  design: DesignPair;
  html: string;
}) => {
  const htmlDir = path.dirname(design.htmlPath);
  const issues: FinalOutputPolicyIssue[] = [];
  const seen = new Set<string>();

  for (const reference of collectAssetReferences(html)) {
    const candidates = resolveReferenceCandidates(reference.ref, htmlDir);
    if (!candidates.length) continue;
    const key = `${reference.source}:${cleanReference(reference.ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exists = await Promise.all(candidates.map(fileExists));
    if (exists.some(Boolean)) continue;
    issues.push({
      assetPath: candidates[0],
      kind: "local-asset-missing",
      ref: reference.ref,
      severity: "error",
      summary: `最终 HTML 引用了不存在的本地图片资源 "${reference.ref}"。请修正资源路径或确保文件被写入可访问位置。`,
    });
  }

  return issues;
};

const collectMustUseAssetIssues = async ({
  design,
  html,
  manifestEntries,
}: {
  design: DesignPair;
  html: string;
  manifestEntries: AssetManifestEntry[];
}) => {
  const htmlDir = path.dirname(design.htmlPath);
  const issues: FinalOutputPolicyIssue[] = [];
  const usedPaths = new Set<string>();

  for (const reference of collectAssetReferences(html)) {
    const assetPath = await resolveExistingReferencePath(
      reference.ref,
      htmlDir,
    );
    if (assetPath) usedPaths.add(normalizePathKey(assetPath));
  }

  const missing = manifestEntries.filter(isMustUseAsset).filter((entry) => {
    const candidates = getAssetMetadataRefValues(entry).flatMap((ref) =>
      resolveReferenceCandidates(ref, htmlDir),
    );
    return !candidates.some((candidate) =>
      usedPaths.has(normalizePathKey(candidate)),
    );
  });

  for (const entry of missing) {
    const label =
      entry.assetName ??
      entry.name ??
      getAssetMetadataRefValues(entry)[0] ??
      "asset";
    issues.push({
      assetPath: getAssetMetadataRefValues(entry)[0],
      kind: "must-use-asset-missing",
      ref: String(label),
      severity: "error",
      summary: `最终 HTML 没有引用 manifest 标记为 mustUse 的静态资产 "${label}"。请按 manifest 的 box/resolvedBox 与推荐用途引用；普通可读文字仍必须使用真实 DOM 文本。`,
    });
  }

  return issues;
};

const collectLocalAssetTextMetadataIssues = async ({
  design,
  html,
  metadataLookup,
}: {
  design: DesignPair;
  html: string;
  metadataLookup: Awaited<ReturnType<typeof createAssetMetadataLookup>>;
}) => {
  const htmlDir = path.dirname(design.htmlPath);
  const issues: FinalOutputPolicyIssue[] = [];
  const seen = new Set<string>();

  for (const reference of collectAssetReferences(html)) {
    const assetPath = await resolveExistingReferencePath(
      reference.ref,
      htmlDir,
    );
    if (!assetPath) continue;
    const clean = cleanReference(reference.ref);
    const basename = path
      .basename(clean)
      .replace(/\.(?:svg|png|webp|jpe?g|avif)$/i, "");
    const metadata =
      metadataLookup.byPath.get(normalizePathKey(assetPath)) ??
      metadataLookup.byBasename.get(basename);
    if (!metadata) continue;

    const descriptor = getAssetMetadataDescriptor(metadata);
    const key = `${reference.ref}:${descriptor}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (descriptorDeclaresTextScrubbing(descriptor)) {
      issues.push({
        assetPath,
        kind: "local-asset-text-scrubbed",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了声明为普通文字已模糊/打码/遮罩后复用的图片资源 "${reference.ref}"。不能用马赛克或糊字图片冒充无文本资源，应拆成干净视觉资源和真实 HTML 文本。`,
      });
      continue;
    }

    const containsText =
      metadata.containsText === true || metadata.containsIntrinsicText === true;
    if (
      descriptorDeclaresReadableText(descriptor) ||
      (containsText && !descriptorDeclaresStylizedText(descriptor))
    ) {
      issues.push({
        assetPath,
        kind: "local-asset-readable-text",
        ref: reference.ref,
        severity: "error",
        summary: `最终 HTML 引用了 metadata 显示含普通可读文字/文字路径的图片资源 "${reference.ref}"。普通文字应使用真实 DOM 文本，不应保留在 SVG/图片资源里。`,
      });
    }
  }

  return issues;
};

const hasNearTransparentColorDeclaration = (body: string) => {
  for (const match of body.matchAll(
    /(?:^|;)\s*(?:color|fill)\s*:\s*rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)\s*(?:!important)?\s*(?:;|$)/gi,
  )) {
    const alpha = Number(match[1]);
    if (Number.isFinite(alpha) && alpha <= 0.05) return true;
  }

  for (const match of body.matchAll(
    /(?:^|;)\s*(?:color|fill)\s*:\s*#(?:[0-9a-f]{6})([0-9a-f]{2})\s*(?:!important)?\s*(?:;|$)/gi,
  )) {
    const alpha = Number.parseInt(match[1] ?? "ff", 16) / 255;
    if (Number.isFinite(alpha) && alpha <= 0.05) return true;
  }

  return false;
};

const isHiddenDeclaration = (body: string) =>
  /(?:^|;)\s*opacity\s*:\s*(?:0|0\.0+)\s*(?:!important)?\s*(?:;|$)/i.test(
    body,
  ) ||
  /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:!important)?\s*(?:;|$)/i.test(body) ||
  /(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/i.test(body) ||
  hasNearTransparentColorDeclaration(body);

const isProtectedContentSelector = (selector: string) => {
  if (
    /(?:aria-hidden|__asset|__art|decor|decoration|bg|background|glow|shadow|flare|spark|icon)/i.test(
      selector,
    )
  ) {
    return false;
  }

  return /(?:text|title|label|price|amount|balance|reward|card|item|list|button|btn|claim|upgrade|progress|article|section|content|data-module-id|design-module|design-page|module-\d{2}|screen|app-root)/i.test(
    selector,
  );
};

const collectHiddenSemanticDomIssues = (html: string) => {
  const issues: FinalOutputPolicyIssue[] = [];
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  const rulePattern = /([^{}@][^{}]*)\{([^{}]*)\}/g;

  for (const styleMatch of html.matchAll(stylePattern)) {
    const css = styleMatch[1] ?? "";
    for (const ruleMatch of css.matchAll(rulePattern)) {
      const selectorText = (ruleMatch[1] ?? "").trim();
      const body = ruleMatch[2] ?? "";
      if (!selectorText || !isHiddenDeclaration(body)) continue;
      const selectors = selectorText
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean);
      for (const selector of selectors) {
        if (!isProtectedContentSelector(selector)) continue;
        issues.push({
          kind: "hidden-semantic-dom",
          selector,
          severity: "error",
          summary: `最终 HTML 通过 CSS 隐藏了语义/内容节点 "${selector}"。不能用原始视觉层覆盖后把真实 DOM 设为不可见。`,
        });
      }
    }
  }

  const inlineHiddenPattern =
    /<([a-z][\w:-]*)\b([^>]*)\bstyle\s*=\s*(["'])(.*?)\3([^>]*)>/gi;
  for (const match of html.matchAll(inlineHiddenPattern)) {
    const attrs = `${match[2] ?? ""} ${match[5] ?? ""}`;
    const style = match[4] ?? "";
    if (!isHiddenDeclaration(style)) continue;
    const label =
      attrs.match(/\b(?:id|class)\s*=\s*(["'])(.*?)\1/i)?.[2] ??
      match[1] ??
      "element";
    if (!isProtectedContentSelector(label)) continue;
    issues.push({
      kind: "hidden-semantic-dom",
      selector: label,
      severity: "error",
      summary: `最终 HTML 通过 inline style 隐藏了语义/内容节点 "${label}"。不能用隐藏主 DOM 的方式降低 diff。`,
    });
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.kind}:${issue.selector}:${issue.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const collectHtmlIntegrityPolicyIssues = ({
  design,
  html,
}: {
  design: DesignPair;
  html: string;
}): FinalOutputPolicyIssue[] =>
  collectHtmlIntegrityIssues(html, design).map((summary) => ({
    kind: "html-integrity",
    selector: design.htmlPath,
    severity: "error",
    summary,
  }));

const createFinalOutputPolicyReport = async ({
  artifactDir,
  htmlPath,
  inputPath,
  scale,
}: {
  artifactDir: string;
  htmlPath?: string;
  inputPath: string;
  scale?: number;
}) => {
  const resolvedDesign = htmlPath
    ? await resolveSvgDesign(inputPath, { scale })
    : await resolveDesignPair(inputPath, { scale });
  const design = htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : resolvedDesign;
  const outputPath = path.join(artifactDir, "final-output-policy.json");
  const markdownPath = path.join(artifactDir, "final-output-policy.md");
  const html = await readFile(design.htmlPath, "utf8");
  const manifestEntries = await readAllAssetManifestEntries({
    artifactDir,
  });
  const metadataLookup = await createAssetMetadataLookup(
    design,
    manifestEntries,
  );
  const issues = [
    ...collectHtmlIntegrityPolicyIssues({ design, html }),
    ...collectOriginalSvgReferenceIssues({ design, html }),
    ...(await collectMissingLocalAssetIssues({ design, html })),
    ...(await collectMustUseAssetIssues({
      design,
      html,
      manifestEntries,
    })),
    ...(await collectLocalAssetTextMetadataIssues({
      design,
      html,
      metadataLookup,
    })),
    ...(await collectLargeVisualLayerIssues({
      artifactDir,
      design,
      html,
      manifestEntries,
    })),
    ...collectHiddenSemanticDomIssues(html),
  ];

  const criticalIssueCount = issues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const report: FinalOutputPolicyReport = {
    criticalIssueCount,
    designName: design.designName,
    issueCount: issues.length,
    issues,
    passed: criticalIssueCount === 0,
  };

  await writeJsonFile(outputPath, report);
  await writeTextFile(
    markdownPath,
    [
      "# Final Output Policy",
      "",
      `- design: ${design.designName}`,
      `- passed: ${report.passed}`,
      `- issues: ${report.issueCount}`,
      `- critical: ${report.criticalIssueCount}`,
      "",
      "## Issues",
      ...(issues.length
        ? issues.map((issue) => {
            const where =
              issue.selector ?? issue.ref ?? issue.assetPath ?? "unknown";
            return `- [${issue.severity}] ${issue.kind}: ${where} — ${issue.summary}`;
          })
        : ["- none"]),
      "",
    ].join("\n"),
  );

  return { markdownPath, outputPath, report };
};

export type { FinalOutputPolicyIssue, FinalOutputPolicyReport };
export {
  collectAssetReferences,
  createFinalOutputPolicyReport,
  resolveReferenceCandidates,
};
