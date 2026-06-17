import { stat } from "node:fs/promises";
import path from "node:path";

import { safeDecodeUri } from "../core/io.js";
import type { Region } from "../core/utils.js";
import { isRecord } from "../core/utils.js";
import {
  type ModuleOutputDiagnostic,
} from "./module-output-contract.js";
import {
  isString,
  normalizePathForCompare,
  unique,
} from "./module-merge/utils.js";

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
  matchedTextBlockIds?: string[];
  mediaType?: null | string;
  mimeType?: null | string;
  name?: null | string;
  path?: null | string;
  pngPath?: null | string;
  overlapsReadableText?: boolean;
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
  manifest?: unknown;
  manifestRaw: string;
  moduleCss: string;
  previewFragmentHtml: string;
  sourceDataRaw?: string;
  sourceFragment?: string;
  sourceFragmentLabel?: string;
  sourceFragmentRaw?: string;
};

type ModuleOutputPolicy = {
  allowedAssets?: ModuleOutputAllowedAsset[];
  design?: ModuleOutputDesign;
  renderEntryPath?: string;
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

const SUPPORTED_MODULE_ASSET_EXTENSIONS = [
  ".svg",
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

const MODULE_CSS_MAX_BYTES = parsePositiveIntegerEnv(
  "MODULE_CSS_MAX_BYTES",
  320_000,
);
const MODULE_CSS_MAX_GRADIENTS = parsePositiveIntegerEnv(
  "MODULE_CSS_MAX_GRADIENTS",
  80,
);
const MODULE_CSS_MAX_BOX_SHADOW_LAYERS = parsePositiveIntegerEnv(
  "MODULE_CSS_MAX_BOX_SHADOW_LAYERS",
  180,
);
const MODULE_CSS_MAX_POLYGON_POINTS = parsePositiveIntegerEnv(
  "MODULE_CSS_MAX_POLYGON_POINTS",
  160,
);

const stripQueryHash = (value: string) => value.split(/[?#]/, 1)[0] ?? value;

const stripFileUrl = (value: string) =>
  value.startsWith("file://") ? value.slice("file://".length) : value;

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

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

const JSON_ASSET_REFERENCE_KEYS = new Set([
  "assetpath",
  "avifpath",
  "href",
  "htmlref",
  "jpegpath",
  "jpgpath",
  "path",
  "pngpath",
  "relativepath",
  "src",
  "sourcepath",
  "svgpath",
  "url",
  "webppath",
]);

const isJsonAssetReferenceKey = (key: string) =>
  JSON_ASSET_REFERENCE_KEYS.has(key.replace(/[-_\s]/g, "").toLowerCase());

const collectJsonAssetReferences = (value: unknown, source: string) => {
  const refs: AssetReference[] = [];
  const visit = (current: unknown, key?: string) => {
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, key));
      return;
    }
    if (isRecord(current)) {
      Object.entries(current).forEach(([childKey, child]) =>
        visit(child, childKey),
      );
      return;
    }
    if (
      key &&
      isJsonAssetReferenceKey(key) &&
      isString(current) &&
      isLocalAssetReference(current)
    ) {
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
  renderEntryPath,
  rawPath,
  strings,
}: {
  absolutePaths: Set<string>;
  baseDirs?: string[];
  renderEntryPath?: string;
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

    if (renderEntryPath) {
      const relativeFromHtml = normalizeSlashes(
        path.relative(path.dirname(renderEntryPath), cleaned),
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

  if (renderEntryPath && !cleaned.startsWith("/")) {
    absolutePaths.add(
      normalizeAbsolutePath(
        path.resolve(path.dirname(renderEntryPath), cleaned),
      ),
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
  renderEntryPath,
}: Pick<ModuleOutputPolicy, "allowedAssets" | "renderEntryPath"> & {
  baseDirs?: string[];
}) => {
  const strings = new Set<string>();
  const absolutePaths = new Set<string>();

  for (const asset of allowedAssets) {
    for (const rawPath of getAllowedAssetPathValues(asset)) {
      addAllowedReferenceVariants({
        absolutePaths,
        baseDirs,
        renderEntryPath,
        rawPath,
        strings,
      });
    }
  }

  return { absolutePaths, strings };
};

const isAllowedAssetReference = ({
  allowedLookup,
  renderEntryPath,
  moduleDir,
  ref,
}: {
  allowedLookup: ReturnType<typeof buildAllowedLookup>;
  renderEntryPath?: string;
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

  if (renderEntryPath && !cleaned.startsWith("/")) {
    if (
      allowedLookup.absolutePaths.has(
        normalizeAbsolutePath(
          path.resolve(path.dirname(renderEntryPath), cleaned),
        ),
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

const isPathInside = (candidate: string, parent: string) => {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedParent = normalizePathForCompare(parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
};

const resolveReferenceCandidates = ({
  renderEntryPath,
  moduleDir,
  ref,
}: {
  renderEntryPath?: string;
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
      renderEntryPath
        ? path.resolve(path.dirname(renderEntryPath), cleaned)
        : undefined,
    ].filter(isString),
  );
};

const isModuleLocalAssetReference = ({
  renderEntryPath,
  moduleDir,
  ref,
}: {
  renderEntryPath?: string;
  moduleDir: string;
  ref: string;
}) => {
  if (!isLocalAssetReference(ref)) return false;
  const assetDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR);
  return resolveReferenceCandidates({ renderEntryPath, moduleDir, ref }).some(
    (candidate) => isPathInside(candidate, assetDir),
  );
};

const moduleLocalAssetReferenceExists = async ({
  renderEntryPath,
  moduleDir,
  ref,
}: {
  renderEntryPath?: string;
  moduleDir: string;
  ref: string;
}) => {
  if (!isLocalAssetReference(ref)) return false;
  const assetDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR);
  for (const candidate of resolveReferenceCandidates({
    renderEntryPath,
    moduleDir,
    ref,
  })) {
    if (isPathInside(candidate, assetDir) && await fileExists(candidate)) {
      return true;
    }
  }
  return false;
};

const collectGeneratedAssetDeclarations = (
  _manifest: unknown,
  allowedAssets?: ModuleOutputAllowedAsset[],
): GeneratedAssetDeclaration[] => {
  return (allowedAssets ?? []).flatMap((asset) => {
    const ref = getGeneratedAssetRef(asset);
    if (!ref) return [];
    return [
      {
        box: getAssetBox(asset),
        raw: asset,
        ref,
      } satisfies GeneratedAssetDeclaration,
    ];
  });
};

const resolveGeneratedBitmapAssetPath = async ({
  policy,
  ref,
}: {
  policy: ModuleOutputPolicy;
  ref: string;
}) => {
  const assetDir = path.join(policy.moduleDir, MODULE_LOCAL_ASSET_DIR);
  const candidates = resolveReferenceCandidates({
    renderEntryPath: policy.renderEntryPath,
    moduleDir: policy.moduleDir,
    ref,
  }).filter((candidate) => isPathInside(candidate, assetDir));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[0];
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
        `${policy.moduleId}: generatedAssets[${index}] must declare a local asset path/ref`,
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
        renderEntryPath: policy.renderEntryPath,
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
        `${policy.moduleId}: generated asset "${label}" is declared in generatedAssets but the file does not exist: ${ref}`,
      );
    }

    const box = declaration.box;
    if (!box) {
      issues.push(
        `${policy.moduleId}: generated asset "${label}" must include absolute position box metadata for layout review`,
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
  content,
  label,
  moduleId,
}: {
  content: string;
  label: string;
  moduleId: string;
}) =>
  /<svg\b/i.test(content)
    ? [
        `${moduleId}: ${label} contains inline <svg>; final render integrity forbids inline SVG, so use CSS/HTML shapes or write a bounded local asset file and reference it`,
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

const collectSourceFragmentBoundaryIssues = ({
  content,
  label,
  moduleId,
}: {
  content: string;
  label: string;
  moduleId: string;
}) => {
  const issues: string[] = [];
  if (label === "source.fragment.jsx") {
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/^\s*import\b/m, "import statements"],
      [/^\s*export\b/m, "export statements"],
      [/\b(?:function|class)\s+[A-Z][A-Za-z0-9_]*/m, "component declarations"],
      [/\breturn\s*\(/m, "return wrappers"],
      [/\b(?:ReactDOM|createRoot)\b/m, "React mount code"],
    ];
    for (const [pattern, reason] of forbiddenPatterns) {
      if (pattern.test(content)) {
        issues.push(
          `${moduleId}: ${label} contains ${reason}; it must be a JSX child fragment that the host can embed directly`,
        );
      }
    }
  }

  if (label === "source.fragment.vue.html") {
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/<\/?template\b/i, "a <template> wrapper"],
      [/<\/?script\b/i, "script blocks"],
      [/<\/?style\b/i, "style blocks"],
      [/\bexport\s+default\b/i, "export default"],
    ];
    for (const [pattern, reason] of forbiddenPatterns) {
      if (pattern.test(content)) {
        issues.push(
          `${moduleId}: ${label} contains ${reason}; it must be a Vue template body fragment that the host can embed directly`,
        );
      }
    }
  }

  return unique(issues);
};

const collectFrameworkInlineDataIssues = ({
  content,
  label,
  moduleId,
}: {
  content: string;
  label: string;
  moduleId: string;
}) => {
  const issues: string[] = [];
  if (label === "source.fragment.vue.html") {
    for (const match of content.matchAll(
      /\B:([A-Za-z_][\w:-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
    )) {
      const prop = (match[1] ?? "").toLowerCase();
      const value = (match[3] ?? "").trim();
      if (prop === "style" || prop === "class") continue;
      if (/^[\[{]/.test(value) && value.length > 24) {
        issues.push(
          `${moduleId}: ${label} inlines structured data in bound prop ":${match[1]}"; put arrays/objects/state in source-data.json and bind to the generated variable`,
        );
      }
    }
    for (const match of content.matchAll(/\bv-for\s*=\s*(["'])([\s\S]*?)\1/g)) {
      const value = (match[2] ?? "").trim();
      if (/\bin\s*[\[{]/.test(value) && value.length > 24) {
        issues.push(
          `${moduleId}: ${label} inlines structured data in v-for; put the collection in source-data.json and iterate over the generated variable`,
        );
      }
    }
  }
  if (label === "source.fragment.jsx") {
    for (const match of content.matchAll(
      /\b([A-Za-z_][\w]*)\s*=\s*\{\s*([\[{])[\s\S]*?\}/g,
    )) {
      const prop = (match[1] ?? "").toLowerCase();
      if (prop === "style" || prop === "classname" || prop === "class") {
        continue;
      }
      issues.push(
        `${moduleId}: ${label} inlines structured data in prop "${match[1]}"; put arrays/objects/state in source-data.json and bind to the generated variable`,
      );
    }
    if (/\{\s*\[[\s\S]{24,}?\]\s*\.map\s*\(/.test(content)) {
      issues.push(
        `${moduleId}: ${label} maps over an inline array; put the collection in source-data.json and map over the generated variable`,
      );
    }
  }
  return unique(issues);
};

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
  moduleCss,
  moduleId,
}: {
  moduleCss: string;
  moduleId: string;
}) => {
  const issues: string[] = [];
  const cssBytes = Buffer.byteLength(moduleCss, "utf8");
  const gradientCount =
    moduleCss.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi)
      ?.length ?? 0;
  const boxShadowLayers = countCssBoxShadowLayers(moduleCss);
  const polygonPoints = countCssPolygonPoints(moduleCss);

  if (cssBytes > MODULE_CSS_MAX_BYTES) {
    issues.push(
      `${moduleId}: module.css is ${cssBytes.toLocaleString("en-US")} bytes; this usually means CSS is drawing complex bitmap/vector art instead of using bounded local assets`,
    );
  }
  if (gradientCount > MODULE_CSS_MAX_GRADIENTS) {
    issues.push(
      `${moduleId}: module.css uses ${gradientCount} CSS gradients; use bitmap/vector assets for complex visual texture/cover art instead of gradient mosaics`,
    );
  }
  if (boxShadowLayers > MODULE_CSS_MAX_BOX_SHADOW_LAYERS) {
    issues.push(
      `${moduleId}: module.css uses ${boxShadowLayers} box-shadow layers; do not recreate images as CSS pixel/mosaic layers`,
    );
  }
  if (polygonPoints > MODULE_CSS_MAX_POLYGON_POINTS) {
    issues.push(
      `${moduleId}: module.css uses ${polygonPoints} clip-path polygon points; use a bounded vector/raster asset for complex silhouettes`,
    );
  }

  const fullBleedGradientBlocks = collectFullBleedGradientBlocks(moduleCss);
  if (fullBleedGradientBlocks.length) {
    issues.push(
      `${moduleId}: module.css has full-bleed gradient visual layers (${fullBleedGradientBlocks.join(", ")}); avoid whole-module CSS background approximation`,
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
  const sourceFragmentLabel = payload.sourceFragmentLabel ?? "source fragment";
  const sourceFragmentForPolicy =
    payload.sourceFragmentRaw ?? payload.sourceFragment;
  const sources = [
    ["preview.fragment.html", payload.previewFragmentHtml],
    ["module.css", payload.moduleCss],
    ["manifest.json", payload.manifestRaw],
    ...(payload.sourceDataRaw !== undefined
      ? ([["source-data.json", payload.sourceDataRaw]] as const)
      : []),
    ...(sourceFragmentForPolicy !== undefined
      ? ([[sourceFragmentLabel, sourceFragmentForPolicy]] as const)
      : []),
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
      moduleCss: payload.moduleCss,
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
      content: payload.previewFragmentHtml,
      label: "preview.fragment.html",
      moduleId: policy.moduleId,
    }),
  );
  if (sourceFragmentForPolicy !== undefined) {
    issues.push(
      ...collectSourceFragmentBoundaryIssues({
        content: sourceFragmentForPolicy,
        label: sourceFragmentLabel,
        moduleId: policy.moduleId,
      }),
      ...collectFrameworkInlineDataIssues({
        content: sourceFragmentForPolicy,
        label: sourceFragmentLabel,
        moduleId: policy.moduleId,
      }),
      ...collectInlineSvgIssues({
        content: sourceFragmentForPolicy,
        label: sourceFragmentLabel,
        moduleId: policy.moduleId,
      }),
    );
  }

  const generatedAssetDeclarations = collectGeneratedAssetDeclarations(
    payload.manifest,
    policy.allowedAssets,
  );
  issues.push(
    ...(await collectGeneratedAssetIssues({
      declarations: generatedAssetDeclarations,
      policy,
    })),
  );
  const policyAllowedAssets = [
    ...(policy.allowedAssets ?? []),
    ...generatedDeclarationsToAllowedAssets(generatedAssetDeclarations),
  ];
  const allowedLookup = buildAllowedLookup({
    allowedAssets: policyAllowedAssets,
    baseDirs: [policy.moduleDir],
    renderEntryPath: policy.renderEntryPath,
  });
  const refs = [
    ...collectMarkupAssetReferences(
      payload.previewFragmentHtml,
      "preview.fragment.html",
    ),
    ...collectMarkupAssetReferences(payload.moduleCss, "module.css"),
    ...collectJsonAssetReferences(payload.manifest, "manifest.json"),
    ...(payload.sourceFragment !== undefined
      ? collectMarkupAssetReferences(payload.sourceFragment, sourceFragmentLabel)
      : []),
  ];
  const seenRefs = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.source}:${normalizeReferenceString(ref.ref)}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    if (
      isAllowedAssetReference({
        allowedLookup,
        renderEntryPath: policy.renderEntryPath,
        moduleDir: policy.moduleDir,
        ref: ref.ref,
      })
    ) {
      continue;
    }
    if (
      isModuleLocalAssetReference({
        renderEntryPath: policy.renderEntryPath,
        moduleDir: policy.moduleDir,
        ref: ref.ref,
      })
    ) {
      if (
        await moduleLocalAssetReferenceExists({
          renderEntryPath: policy.renderEntryPath,
          moduleDir: policy.moduleDir,
          ref: ref.ref,
        })
      ) {
        continue;
      }
      issues.push(
        `${policy.moduleId}: ${ref.source} references module-local asset that does not exist under assets/: ${ref.ref}`,
      );
      continue;
    }
    issues.push(
      `${policy.moduleId}: ${ref.source} references local asset outside the module assets/ directory or registered generatedAssets: ${ref.ref}`,
    );
  }

  return issues;
};

const parsePolicyMessageLocation = (message: string) => {
  const match = message.match(/^[^:]+:\s*([^:]+?):\s/);
  if (!match?.[1]) return {};
  return { file: match[1].trim() };
};

const inferDiagnosticMetadata = (
  message: string,
): Omit<ModuleOutputDiagnostic, "message" | "severity"> => {
  if (/must include absolute position box metadata/i.test(message)) {
    return {
      code: "generated-asset-missing-box",
      field: "generatedAssets[].box",
      file: "module-semantic.json",
      fixHint:
        "Add the asset's local rendered x/y/width/height to generatedAssets[].box.",
    };
  }
  if (/must declare a local asset path\/ref/i.test(message)) {
    return {
      code: "generated-asset-missing-path",
      field: "generatedAssets[].path",
      file: "module-semantic.json",
      fixHint: "Declare a module-local path under assets/.",
    };
  }
  if (/must live under assets\//i.test(message)) {
    return {
      code: "generated-asset-outside-assets-dir",
      field: "generatedAssets[].path",
      file: "module-semantic.json",
      fixHint: "Move the file under the module assets/ directory and update references.",
    };
  }
  if (/declared in generatedAssets but the file does not exist/i.test(message)) {
    return {
      code: "generated-asset-file-missing",
      field: "generatedAssets[].path",
      file: "module-semantic.json",
      fixHint: "Create/export the asset file or remove the manifest entry.",
    };
  }
  if (/embeds data:image content/i.test(message)) {
    return {
      code: "data-image",
      ...parsePolicyMessageLocation(message),
      fixHint: "Write a bounded file under assets/ and reference that file instead.",
    };
  }
  if (/contains inline <svg>/i.test(message)) {
    return {
      code: "inline-svg",
      ...parsePolicyMessageLocation(message),
      fixHint: "Export the visual as a bounded asset or rebuild it with allowed HTML/CSS.",
    };
  }
  if (/references module-local asset that does not exist under assets\//i.test(message)) {
    return {
      code: "local-asset-missing",
      ...parsePolicyMessageLocation(message),
      field: "assets",
      fixHint:
        "Create/export the referenced file under assets/ and prefer --register-semantic so metadata is recorded.",
    };
  }
  if (
    /references local asset outside the module assets\/ directory or registered generatedAssets/i.test(
      message,
    )
  ) {
    return {
      code: "local-asset-outside-allowed",
      ...parsePolicyMessageLocation(message),
      fixHint:
        "Use a file under the module assets/ directory, or reference an asset registered in module-semantic.json generatedAssets.",
    };
  }
  if (/references the original whole SVG/i.test(message)) {
    return {
      code: "original-svg-reference",
      fixHint: "Do not reference the source design SVG as a render layer.",
    };
  }
  return {
    code: "module-output-policy",
    ...parsePolicyMessageLocation(message),
  };
};

const toPolicyDiagnostic = (message: string): ModuleOutputDiagnostic => {
  return {
    ...inferDiagnosticMetadata(message),
    message,
    severity: "warning",
  };
};

const collectModuleOutputPolicyDiagnostics = async (
  payload: ModuleOutputPayload,
  policy: ModuleOutputPolicy,
): Promise<ModuleOutputDiagnostic[]> =>
  (await collectModuleOutputPolicyIssues(payload, policy)).map(toPolicyDiagnostic);

export type {
  ModuleOutputAllowedAsset,
  ModuleOutputDesign,
  ModuleOutputDiagnostic,
  ModuleOutputPayload,
  ModuleOutputPolicy,
};
export {
  MODULE_LOCAL_ASSET_DIR,
  collectModuleOutputPolicyDiagnostics,
  getAllowedAssetPathValues,
  isPathInside,
  isSupportedModuleAssetPath,
  normalizeSlashes,
};
