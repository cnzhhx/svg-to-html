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

export { compactAttrValue, inspectSvgSource };
export type { SvgInspection };
