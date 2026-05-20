import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { SvgVerticalModule } from "../../core/svg-vertical-modules/types.js";
import { writeJsonFile, writeTextFile } from "../../core/utils.js";

type JsonRecord = Record<string, unknown>;

type SvgInspectionElement = {
  attrs: Record<string, string>;
  index: number;
  tag: string;
};

type SvgInspection = {
  bytes: number;
  elementSamples: SvgInspectionElement[];
  height?: number;
  imageCount: number;
  maskOrClipCount: number;
  pathCount: number;
  rootAttrs: Record<string, string>;
  tagCounts: Record<string, number>;
  textSamples: string[];
  viewBox?: string;
  width?: number;
};

type SvgInspectionOptions = {
  fromIndex?: number;
  maxElementSamples?: number;
  tags?: string[];
};

type WriteModuleInputSummaryInput = {
  allowedAssetsPath: string;
  module: SvgVerticalModule;
  moduleDir: string;
  moduleOcrBlocksPath: string;
  scale: number;
  moduleTextStyleHintsPath?: string;
  moduleTextBlocksPath?: string;
  moduleSvgPath: string;
};

const IMPORTANT_ATTRS = new Set([
  "class",
  "clip-path",
  "cx",
  "cy",
  "fill",
  "filter",
  "height",
  "href",
  "id",
  "mask",
  "opacity",
  "r",
  "rx",
  "ry",
  "stroke",
  "transform",
  "viewBox",
  "width",
  "x",
  "xlink:href",
  "y",
]);

const ELEMENT_SAMPLE_TAGS = new Set([
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
]);

const MAX_ATTR_VALUE_LENGTH = 160;
const MAX_TEXT_SAMPLE_LENGTH = 160;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonFile = async (filePath: string) =>
  JSON.parse(await readFile(filePath, "utf8")) as unknown;

const parseNumberAttr = (value: string | undefined) => {
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseAttrs = (source: string) => {
  const attrs: Record<string, string> = {};
  const attrPattern =
    /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(attrPattern)) {
    const name = match[1];
    if (!name) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
};

const compactAttrValue = (name: string, value: string) => {
  if (/^(?:href|xlink:href)$/i.test(name) && /^data:/i.test(value)) {
    return `${value.slice(0, 80)}... [data-uri ${value.length} chars]`;
  }
  if (value.length <= MAX_ATTR_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_ATTR_VALUE_LENGTH)}... [${value.length} chars]`;
};

const pickImportantAttrs = (attrs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(attrs)
      .filter(([name]) => IMPORTANT_ATTRS.has(name))
      .map(([name, value]) => [name, compactAttrValue(name, value)]),
  );

const normalizeText = (value: string) =>
  value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_SAMPLE_LENGTH);

const inspectSvgSource = ({
  fromIndex = 0,
  maxElementSamples = 120,
  tags,
  svg,
}: SvgInspectionOptions & {
  svg: string;
}): Omit<SvgInspection, "bytes"> => {
  const rootAttrs = pickImportantAttrs(
    parseAttrs(svg.match(/<svg\b([^>]*)>/i)?.[1] ?? ""),
  );
  const tagCounts: Record<string, number> = {};
  const elementSamples: SvgInspectionElement[] = [];
  const requestedTags = new Set(
    (tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
  const sampleTags = requestedTags.size ? requestedTags : ELEMENT_SAMPLE_TAGS;
  let index = 0;

  for (const match of svg.matchAll(/<\s*([A-Za-z][\w:-]*)\b([^>]*)>/g)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (!tag || tag.startsWith("/")) continue;
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    if (
      index >= fromIndex &&
      sampleTags.has(tag) &&
      elementSamples.length < maxElementSamples
    ) {
      elementSamples.push({
        attrs: pickImportantAttrs(parseAttrs(match[2] ?? "")),
        index,
        tag,
      });
    }
    index += 1;
  }

  const textSamples = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((match) => normalizeText(match[1] ?? ""))
    .filter(Boolean)
    .slice(0, 80);

  return {
    elementSamples,
    height:
      parseNumberAttr(rootAttrs.height) ??
      parseNumberAttr(rootAttrs.viewBox?.trim().split(/[\s,]+/)[3]),
    imageCount: tagCounts.image ?? 0,
    maskOrClipCount:
      (tagCounts.mask ?? 0) +
      (tagCounts.clippath ?? 0) +
      (tagCounts.filter ?? 0),
    pathCount: tagCounts.path ?? 0,
    rootAttrs,
    tagCounts,
    textSamples,
    viewBox: rootAttrs.viewBox,
    width:
      parseNumberAttr(rootAttrs.width) ??
      parseNumberAttr(rootAttrs.viewBox?.trim().split(/[\s,]+/)[2]),
  };
};

const readBlocks = async (filePath: string) => {
  const parsed = await readJsonFile(filePath).catch(() => null);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed) && Array.isArray(parsed.blocks)) {
    return parsed.blocks.filter(isRecord);
  }
  return [];
};

const readAssets = async (filePath: string) => {
  const parsed = await readJsonFile(filePath).catch(() => null);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed) && Array.isArray(parsed.assets)) {
    return parsed.assets.filter(isRecord);
  }
  return [];
};

const readTextStyleHints = async (filePath: string) => {
  const parsed = await readJsonFile(filePath).catch(() => null);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (isRecord(parsed) && Array.isArray(parsed.blocks)) {
    return parsed.blocks.filter(isRecord);
  }
  return [];
};

const compactBox = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const { height, width, x, y } = value;
  return { height, width, x, y };
};

const renderMarkdownTable = (headers: string[], rows: string[][]) => {
  if (!rows.length) return "(none)";
  return [
    `| ${headers.join(" |")} |`,
    `| ${headers.map(() => "---").join(" |")} |`,
    ...rows.map((row) => `| ${row.join(" |")} |`),
  ].join("\n");
};

const escapeCell = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .slice(0, 120);

const writeModuleInputSummary = async ({
  allowedAssetsPath,
  module,
  moduleDir,
  moduleOcrBlocksPath,
  scale,
  moduleTextStyleHintsPath,
  moduleTextBlocksPath,
  moduleSvgPath,
}: WriteModuleInputSummaryInput) => {
  const [
    svg,
    svgStat,
    assets,
    ocrBlocks,
    textBlocks,
    textStyleHints,
  ] =
    await Promise.all([
      readFile(moduleSvgPath, "utf8"),
      stat(moduleSvgPath),
      readAssets(allowedAssetsPath),
      readBlocks(moduleOcrBlocksPath),
      moduleTextBlocksPath
        ? readBlocks(moduleTextBlocksPath)
        : Promise.resolve([]),
      moduleTextStyleHintsPath
        ? readTextStyleHints(moduleTextStyleHintsPath)
        : Promise.resolve([]),
    ]);
  const inspection: SvgInspection = {
    bytes: svgStat.size,
    ...inspectSvgSource({ svg }),
  };
  const assetSummary = assets.map((asset) => ({
    assetName: asset.assetName ?? asset.name,
    assetRole: asset.assetRole,
    kind: asset.assetKind ?? asset.kind,
    moduleBox: compactBox(asset.moduleBox),
    overlapsOcrText: asset.overlapsOcrText,
    priority: asset.priority,
    relativePath: asset.relativePath ?? asset.htmlRef,
    risk: asset.risk,
    riskReasons: asset.riskReasons,
    textTreatment: asset.textTreatment,
  }));
  const ocrSummary = ocrBlocks.map((block) => ({
    bbox: compactBox(block.bbox),
    confidence: block.confidence,
    id: block.id,
    role: block.role,
    text: block.text,
  }));
  const textSummary = textBlocks.map((block) => ({
    bboxIncludesIcon: block.bboxIncludesIcon,
    confidence: block.confidence,
    id: block.id,
    kind: block.kind,
    region: compactBox(block.region),
    source: block.source,
    sourceOcrText: block.sourceOcrText,
    text: block.text,
    textRegion: compactBox(block.textRegion),
  }));
  const textStyleSummary = textStyleHints.map((hint) => {
    const declarations = isRecord(hint.declarations)
      ? (hint.declarations as Record<string, unknown>)
      : {};
    const fit = isRecord(hint.fit) ? hint.fit : {};
    return {
      declarations: {
        "font-family": declarations["font-family"],
        "font-size": declarations["font-size"],
        "font-weight": declarations["font-weight"],
        "letter-spacing": declarations["letter-spacing"],
        "line-height": declarations["line-height"],
      },
      fitScore: fit.score,
      id: hint.id,
      kind: hint.kind,
      region: compactBox(hint.region),
      text: hint.text,
    };
  });
  const payload = {
    allowedAssets: assetSummary,
    guidance: {
      exportSvgNodeCommand:
        `pnpm --dir <repo> exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --index <inspect-index> --output assets/<name>.png --padding 2 --scale ${scale}`,
      inspectCommand:
        "pnpm --dir <repo> exec tsx src/cli/inspect-module-svg.ts --module-dir <module-dir> --format text --tag image --max-elements 40",
      readPolicy:
        "Use this summary, OCR blocks, allowed assets, and targeted inspect output first. Do not dump module.svg into the model context. Do not crop assets from generated PNG screenshots; export SVG node assets from module.svg with the official export command.",
    },
    module: {
      id: module.id,
      kind: module.kind,
      region: module.region,
      scale,
    },
    textBlocks: textSummary,
    textStyleHints: textStyleSummary,
    moduleSvg: {
      path: moduleSvgPath,
      ...inspection,
    },
    ocrBlocks: ocrSummary,
  };
  const jsonPath = path.join(moduleDir, "module-input-summary.json");
  const markdownPath = path.join(moduleDir, "module-input-summary.md");

  await writeJsonFile(jsonPath, payload);
  await writeTextFile(
    markdownPath,
    [
      `# Module Input Summary`,
      "",
      `- module: ${module.id}`,
      `- region: x=${module.region.x}, y=${module.region.y}, w=${module.region.width}, h=${module.region.height}`,
      `- SVG render scale: ${scale}x`,
      `- module.svg: ${svgStat.size} bytes, ${inspection.pathCount} path(s), ${inspection.imageCount} image(s), ${inspection.maskOrClipCount} mask/clip/filter node(s)`,
      `- root viewBox: ${inspection.viewBox ?? "n/a"}`,
      "",
      "## Read Policy",
      "",
      "Do not dump `module.svg` with `cat`, `sed`, or `head`; minified SVGs can be a single multi-megabyte line. Use this summary, OCR blocks, allowed assets, screenshots, and targeted inspect output.",
      "",
      "Do not crop assets from host/generated PNG screenshots such as `module-render.png`, `module-text-source.png`, `svg.png`, `html.png`, or `diff.png`; those images are only for observation and verification. For icons, decorative nodes, logos, and visual lettering, locate the SVG node with inspect output and export it from `module.svg` using `export-svg-node-asset.ts`.",
      "",
      `SVG node asset export template: \`pnpm --dir <repo> exec tsx src/cli/export-svg-node-asset.ts --module-dir <module-dir> --index <inspect-index> --output assets/<name>.png --padding 2 --scale ${scale}\`.`,
      "",
      "Use this explicit session scale for SVG node asset export. CSS sizes and `manifest.generatedAssets[].box` still use rendered local coordinates; do not infer layout from the PNG's intrinsic pixel dimensions.",
      "",
      "## OCR Blocks",
      "",
      "OCR is only a rough locator/debug signal. Prefer Vision Text Blocks below for DOM text and text-layout.",
      "",
      renderMarkdownTable(
        ["id", "text", "bbox", "role", "confidence"],
        ocrSummary.map((block) => [
          escapeCell(block.id),
          escapeCell(block.text),
          escapeCell(JSON.stringify(block.bbox)),
          escapeCell(block.role),
          escapeCell(block.confidence),
        ]),
      ),
      "",
      "## Vision Text Blocks",
      "",
      renderMarkdownTable(
        [
          "id",
          "text",
          "textRegion",
          "region",
          "kind",
          "confidence",
          "icon?",
          "source",
        ],
        textSummary.map((block) => [
          escapeCell(block.id),
          escapeCell(block.text),
          escapeCell(JSON.stringify(block.textRegion)),
          escapeCell(JSON.stringify(block.region)),
          escapeCell(block.kind),
          escapeCell(block.confidence),
          escapeCell(block.bboxIncludesIcon),
          escapeCell(block.source),
        ]),
      ),
      "",
      "## Text Style Hints",
      "",
      "Host-inferred typography hints for ordinary DOM text. Use these declarations as the default font-size/font-weight/line-height in fragment.css and copy them into text-layout.json block declarations for the matching text id.",
      "",
      renderMarkdownTable(
        [
          "id",
          "text",
          "region",
          "font-size",
          "font-weight",
          "line-height",
          "fitScore",
        ],
        textStyleSummary.map((hint) => [
          escapeCell(hint.id),
          escapeCell(hint.text),
          escapeCell(JSON.stringify(hint.region)),
          escapeCell(hint.declarations["font-size"]),
          escapeCell(hint.declarations["font-weight"]),
          escapeCell(hint.declarations["line-height"]),
          escapeCell(hint.fitScore),
        ]),
      ),
      "",
      "## Allowed Assets",
      "",
      renderMarkdownTable(
        [
          "name",
          "role",
          "risk",
          "priority",
          "path",
          "moduleBox",
          "textTreatment",
          "overlapsOCR",
        ],
        assetSummary.map((asset) => [
          escapeCell(asset.assetName),
          escapeCell(asset.assetRole ?? asset.kind),
          escapeCell(asset.risk),
          escapeCell(asset.priority),
          escapeCell(asset.relativePath),
          escapeCell(JSON.stringify(asset.moduleBox)),
          escapeCell(asset.textTreatment),
          escapeCell(asset.overlapsOcrText),
        ]),
      ),
      "",
      "## SVG Tag Counts",
      "",
      renderMarkdownTable(
        ["tag", "count"],
        Object.entries(inspection.tagCounts)
          .sort((left, right) => right[1] - left[1])
          .map(([tag, count]) => [escapeCell(tag), escapeCell(count)]),
      ),
      "",
      "## SVG Element Samples",
      "",
      renderMarkdownTable(
        ["index", "tag", "attrs"],
        inspection.elementSamples.map((element) => [
          escapeCell(element.index),
          escapeCell(element.tag),
          escapeCell(JSON.stringify(element.attrs)),
        ]),
      ),
      "",
    ].join("\n"),
  );

  return {
    jsonPath,
    markdownPath,
  };
};

export { inspectSvgSource, writeModuleInputSummary };
export type { SvgInspection };
