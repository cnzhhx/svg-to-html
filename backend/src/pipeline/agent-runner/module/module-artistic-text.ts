import type { Box } from "../../../core/geometry.js";

type ArtisticSpacedTextDecision = {
  compactText: string;
  estimatedFillRatio: number;
  reason: string;
};

const SPACED_GLYPH_FILL_RATIO_MAX = 0.85;
const MIN_SPACED_GLYPH_TOKENS = 4;
const MIN_SPACED_GLYPH_SEPARATORS = 3;
const SINGLE_GLYPH_TOKEN_RATIO_MIN = 0.75;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const FULLWIDTH_RE = /[\uff01-\uff60\uffe0-\uffe6]/u;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/u;

const countSeparators = (text: string) => text.match(/\s+/gu)?.length ?? 0;

const visibleChars = (text: string) => Array.from(text.replace(/\s+/gu, ""));

const isSingleGlyphToken = (token: string) => {
  const chars = Array.from(token);
  if (chars.length !== 1) return false;
  return CJK_RE.test(token) || FULLWIDTH_RE.test(token) || ASCII_ALNUM_RE.test(token);
};

const isLikelySpacedGlyphRun = (text: string) => {
  const tokens = text
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length < MIN_SPACED_GLYPH_TOKENS) return false;
  if (countSeparators(text) < MIN_SPACED_GLYPH_SEPARATORS) return false;
  const singleGlyphTokenCount = tokens.filter(isSingleGlyphToken).length;
  return singleGlyphTokenCount / tokens.length >= SINGLE_GLYPH_TOKEN_RATIO_MIN;
};

const estimateGlyphWidthFromHeight = (char: string, height: number) => {
  if (CJK_RE.test(char) || FULLWIDTH_RE.test(char)) return height;
  if (/[A-Z0-9]/u.test(char)) return height * 0.62;
  if (/[a-z]/u.test(char)) return height * 0.52;
  return height * 0.5;
};

const estimateNaturalWidthAtMaxHeight = (text: string, height: number) =>
  visibleChars(text).reduce(
    (sum, char) => sum + estimateGlyphWidthFromHeight(char, height),
    0,
  );

const detectArtisticSpacedText = ({
  bbox,
  lineCount,
  text,
}: {
  bbox?: Box;
  lineCount?: number;
  text?: string;
}): ArtisticSpacedTextDecision | null => {
  const normalized = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  if (!normalized || !bbox || bbox.width <= 0 || bbox.height <= 0) return null;
  if (typeof lineCount === "number" && lineCount > 1) return null;
  if (!isLikelySpacedGlyphRun(normalized)) return null;

  const compactText = normalized.replace(/\s+/gu, "");
  if (visibleChars(compactText).length < MIN_SPACED_GLYPH_TOKENS) return null;

  const naturalWidth = estimateNaturalWidthAtMaxHeight(compactText, bbox.height);
  const estimatedFillRatio = naturalWidth / bbox.width;
  if (estimatedFillRatio >= SPACED_GLYPH_FILL_RATIO_MAX) return null;

  return {
    compactText,
    estimatedFillRatio: Number(estimatedFillRatio.toFixed(3)),
    reason:
      `spaced single-glyph text fills only ${estimatedFillRatio.toFixed(3)} of ` +
      `the target width at max text height; render as visual asset because DOM letter-spacing is not used`,
  };
};

export { detectArtisticSpacedText };
