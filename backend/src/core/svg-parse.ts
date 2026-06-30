import { readFile } from "node:fs/promises";

const DEFAULT_SCALE = 1;

type SvgDimensions = {
  height: number;
  width: number;
};

const readSvgDimensions = (svg: string): SvgDimensions | null => {
  const svgOpen = svg.match(/<svg\b([^>]*)>/i);
  const attrs = svgOpen?.[1] ?? "";
  const getAttr = (name: string) => {
    const match = attrs.match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
  };
  const parseNumber = (value: string | undefined) => {
    const match = value?.match(/-?\d+(?:\.\d+)?/);
    if (!match) return undefined;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const viewBox = getAttr("viewBox");
  const viewBoxNumbers = viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (viewBoxNumbers && viewBoxNumbers.length >= 4) {
    const width = viewBoxNumbers[2]!;
    const height = viewBoxNumbers[3]!;
    if (width > 0 && height > 0) {
      return { height: Math.ceil(height), width: Math.ceil(width) };
    }
  }

  const width = parseNumber(getAttr("width"));
  const height = parseNumber(getAttr("height"));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { height: Math.ceil(height), width: Math.ceil(width) };
  }

  return null;
};

const parseSvgSize = async (svgPath: string, scale = DEFAULT_SCALE) => {
  const svg = await readFile(svgPath, "utf8");
  const dims = readSvgDimensions(svg);
  if (!dims) {
    throw new Error(`Unable to read SVG size: ${svgPath}`);
  }
  return {
    width: Math.round(dims.width * scale),
    height: Math.round(dims.height * scale),
  };
};

/**
 * Ensure the SVG has an explicit viewBox attribute. Without a viewBox, browsers
 * will NOT scale SVG content when the CSS box size differs from the intrinsic
 * width/height attributes. This means getBoundingClientRect() returns original
 * SVG coordinates instead of scaled pixels, breaking the pipeline's assumption
 * that pixelBox values are in rendered (scaled) coordinates.
 */
const ensureSvgViewBox = (markup: string): string => {
  const svgOpenMatch = markup.match(/<svg\b([^>]*)>/i);
  if (!svgOpenMatch) return markup;
  const attrs = svgOpenMatch[1] ?? "";

  // Already has a viewBox — nothing to do.
  if (/\bviewBox\s*=/i.test(attrs)) return markup;

  // Extract intrinsic width/height to derive a viewBox.
  const widthMatch = attrs.match(
    /\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const heightMatch = attrs.match(
    /\bheight\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const parseNum = (m: RegExpMatchArray | null) => {
    const raw = m?.[1] ?? m?.[2] ?? m?.[3];
    const num = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const w = parseNum(widthMatch);
  const h = parseNum(heightMatch);
  if (!w || !h) return markup;

  // Inject viewBox right after the opening <svg tag so content scales properly.
  const viewBox = `viewBox="0 0 ${w} ${h}"`;
  return markup.replace(/<svg\b/i, `<svg ${viewBox}`);
};

export { ensureSvgViewBox, parseSvgSize, readSvgDimensions };
