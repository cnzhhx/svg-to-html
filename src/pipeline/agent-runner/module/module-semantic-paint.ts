import type { ModuleSemanticNode } from "./module-semantic.js";

const parseNumericAttr = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isExplicitPaint = (value: string | undefined) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== "none" &&
    normalized !== "transparent" &&
    !normalized.startsWith("url(")
  );
};

const formatAlpha = (value: number) =>
  Number(value.toFixed(3)).toString();

const applyPaintOpacity = (
  paint: string,
  opacity: number | undefined,
) => {
  if (opacity === undefined || opacity >= 0.999) return paint;
  if (opacity <= 0.001) return "rgba(0, 0, 0, 0)";
  const normalized = paint.trim();
  const alpha = formatAlpha(opacity);

  const hex = normalized.match(
    /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  );
  if (hex) {
    const raw = hex[1]!;
    const expand = (value: string) =>
      value.length === 1 ? `${value}${value}` : value;
    const r = Number.parseInt(
      raw.length <= 4 ? expand(raw[0]!) : raw.slice(0, 2),
      16,
    );
    const g = Number.parseInt(
      raw.length <= 4 ? expand(raw[1]!) : raw.slice(2, 4),
      16,
    );
    const b = Number.parseInt(
      raw.length <= 4 ? expand(raw[2]!) : raw.slice(4, 6),
      16,
    );
    const embeddedAlpha =
      raw.length === 4
        ? Number.parseInt(expand(raw[3]!), 16) / 255
        : raw.length === 8
          ? Number.parseInt(raw.slice(6, 8), 16) / 255
          : 1;
    return `rgba(${r}, ${g}, ${b}, ${formatAlpha(embeddedAlpha * opacity)})`;
  }

  const rgb = normalized.match(
    /^rgb\(\s*([^)]+)\s*\)$/i,
  );
  if (rgb) return `rgba(${rgb[1]}, ${alpha})`;

  return paint;
};

const textColorFromNodePaint = (node: ModuleSemanticNode) => {
  if (!isExplicitPaint(node.attrs.fill)) return undefined;
  const fillOpacity = parseNumericAttr(node.attrs["fill-opacity"]) ?? 1;
  const opacity = parseNumericAttr(node.attrs.opacity) ?? 1;
  return applyPaintOpacity(node.attrs.fill!.trim(), fillOpacity * opacity);
};

const isTransparentPaint = (value: string | undefined) => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "transparent") {
    return true;
  }
  const rgba = normalized.match(
    /^rgba\(\s*[^,]+\s*,\s*[^,]+\s*,\s*[^,]+\s*,\s*([^)]+)\s*\)$/,
  );
  if (rgba) {
    const alpha = Number(rgba[1]);
    return Number.isFinite(alpha) && alpha <= 0.05;
  }
  const hexAlpha = normalized.match(/^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i);
  if (hexAlpha) {
    const alphaHex = normalized.length === 5 ? normalized.slice(4, 5).repeat(2) : normalized.slice(7, 9);
    const alpha = Number.parseInt(alphaHex, 16) / 255;
    return Number.isFinite(alpha) && alpha <= 0.05;
  }
  return false;
};

const isPureTransparentNode = (node: ModuleSemanticNode) => {
  const opacity = parseNumericAttr(node.attrs.opacity);
  if (opacity !== undefined && opacity <= 0.05) return true;
  if (node.attrs.display?.trim().toLowerCase() === "none") return true;
  if (node.attrs.visibility?.trim().toLowerCase() === "hidden") return true;
  if (node.tag === "text" || node.tag === "tspan" || node.tag === "image") {
    return false;
  }

  const fillTransparent =
    isTransparentPaint(node.attrs.fill) ||
    (parseNumericAttr(node.attrs["fill-opacity"]) ?? 1) <= 0.05;
  const strokeTransparent =
    isTransparentPaint(node.attrs.stroke) ||
    (parseNumericAttr(node.attrs["stroke-opacity"]) ?? 1) <= 0.05;

  return fillTransparent && strokeTransparent;
};

const parseHexPaintLuminance = (value: string) => {
  const normalized = value.trim().replace(/^#/, "");
  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized.length === 6
        ? normalized
        : "";
  if (!hex) return undefined;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  if (![red, green, blue].every(Number.isFinite)) return undefined;
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
};

const parseRgbPaintLuminance = (value: string) => {
  const match = value
    .trim()
    .match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+\s*)?\)$/i);
  if (!match) return undefined;
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if (![red, green, blue].every(Number.isFinite)) return undefined;
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
};

const readPaintLuminance = (value: string | undefined) => {
  const token = value?.trim().toLowerCase();
  if (!token || token === "none" || token === "transparent") return undefined;
  if (token === "white") return 1;
  if (token === "black") return 0;
  if (token.startsWith("#")) return parseHexPaintLuminance(token);
  if (token.startsWith("rgb")) return parseRgbPaintLuminance(token);
  return undefined;
};

export {
  applyPaintOpacity,
  isExplicitPaint,
  isPureTransparentNode,
  isTransparentPaint,
  parseNumericAttr,
  readPaintLuminance,
  textColorFromNodePaint,
};
