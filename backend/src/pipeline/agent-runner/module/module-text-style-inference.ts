import { existsSync } from "node:fs";
import path from "node:path";

import {
  inferTextStyles,
  type TextStyleInferenceInputBlock,
  type TextStyleInferenceRecommendation,
} from "../../../core/text-style-inference.js";
import type { Box } from "../../../core/geometry.js";
import { isRecord } from "../../../core/type-guards.js";

type ModuleTextBlock = {
  color?: string;
  confidence?: number;
  id?: string;
  kind?: string;
  lineCount?: number;
  lineRegions?: Box[];
  lines?: Array<{ region?: Box; text?: string }>;
  region?: Box;
  renderedTextRegion?: Box;
  text?: string;
  textRegion?: Box;
};

type ModuleTextBlocksFile = {
  blocks?: ModuleTextBlock[];
  previewPath?: string;
};

type ModuleTextStyleHint = {
  confidence?: number;
  declarations: Record<string, string>;
  fit: TextStyleInferenceRecommendation["fit"];
  id: string;
  kind?: string;
  lineCount?: number;
  lineRegions?: Box[];
  region: Box;
  text: string;
};

type ModuleTextStyleHintsFile = {
  blockCount: number;
  blocks: ModuleTextStyleHint[];
  generatedAt: string;
  generatedBy: "text-style-inference";
  moduleId: string;
  previewPath?: string;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const readBox = (value: unknown): Box | undefined => {
  if (!isRecord(value)) return undefined;
  const { height, width, x, y } = value;
  if (
    !isFiniteNumber(height) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(x) ||
    !isFiniteNumber(y)
  ) {
    return undefined;
  }
  return { height, width, x, y };
};

const readBoxList = (value: unknown): Box[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
      const box = readBox(item);
      return box ? [box] : [];
    })
    : [];

const readLineList = (
  value: unknown,
): Array<{ region: Box; text?: string }> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const region = readBox(item.region);
      if (!region) return [];
      const text =
        typeof item.text === "string" && item.text.trim()
          ? item.text.trim()
          : undefined;
      return [{ region, text }];
    })
    : [];

const extractLineTexts = (
  lines: Array<{ region: Box; text?: string }>,
  explicitTextLines: string[],
) => {
  const lineTexts = lines.flatMap((line) => {
    const text = line.text?.trim();
    return text ? [text] : [];
  });
  if (lineTexts.length > 1) return lineTexts;
  return explicitTextLines.length > 1 ? explicitTextLines : [];
};

const estimateMultilineLineHeight = (regions: Box[], fallback: number) => {
  if (regions.length < 2) return fallback;
  const sorted = [...regions].sort((left, right) => left.y - right.y);
  const deltas = sorted
    .slice(1)
    .map((region, index) => region.y - (sorted[index]?.y ?? region.y))
    .filter((delta) => Number.isFinite(delta) && delta > 0);
  if (!deltas.length) return fallback;
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
};

const splitExplicitTextLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const createVirtualLineRegions = (region: Box, lineCount: number) => {
  if (lineCount <= 1) return [];
  const lineHeight = region.height / lineCount;
  return Array.from({ length: lineCount }, (_, index) => ({
    height: lineHeight,
    width: region.width,
    x: region.x,
    y: region.y + lineHeight * index,
  }));
};

const pickStyleLine = (
  lines: Array<{ region: Box; text?: string }>,
): { region: Box; text?: string } | undefined =>
  [...lines].sort((left, right) => {
    const leftTextScore = left.text ? left.text.length : 0;
    const rightTextScore = right.text ? right.text.length : 0;
    if (leftTextScore !== rightTextScore) return rightTextScore - leftTextScore;
    return right.region.width - left.region.width;
  })[0];

const resolveMaybeRelative = (baseDir: string, filePath?: string) => {
  if (!filePath) return undefined;
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
};

const normalizeModuleTextBlocks = (input: ModuleTextBlocksFile) =>
  (Array.isArray(input.blocks) ? input.blocks : []).flatMap((block) => {
    const id = typeof block.id === "string" ? block.id.trim() : "";
    const text = typeof block.text === "string" ? block.text.trim() : "";
    const region = readBox(block.textRegion) ?? readBox(block.region);
    if (!id || !text || !region) return [];
    const visualRegion = readBox(block.renderedTextRegion);
    const explicitTextLines = splitExplicitTextLines(text);
    const lineCount =
      typeof block.lineCount === 'number' && Number.isFinite(block.lineCount) && block.lineCount >= 1
        ? Math.round(block.lineCount)
        : explicitTextLines.length > 1
          ? explicitTextLines.length
          : undefined;
    const rawLines = readLineList(block.lines);
    const hasTextOnlyLines =
      Array.isArray(block.lines) &&
      block.lines.some(
        (line) =>
          isRecord(line) &&
          typeof line.text === "string" &&
          line.text.trim().length > 0 &&
          !readBox(line.region),
      );
    const rawLineRegions = rawLines.length
      ? rawLines.map((line) => line.region)
      : readBoxList(block.lineRegions);
    const lineRegions = rawLineRegions.length
      ? rawLineRegions
      : !hasTextOnlyLines && typeof lineCount === "number" && lineCount > 1
        ? createVirtualLineRegions(visualRegion ?? region, lineCount)
        : [];
    const lines = rawLines.length
      ? rawLines
      : lineRegions.length
        ? lineRegions.map((lineRegion, index) => ({
          region: lineRegion,
          text:
            explicitTextLines.length === lineRegions.length
              ? explicitTextLines[index]
              : undefined,
        }))
        : explicitTextLines.map((line) => ({ region, text: line }));
    const styleLine = pickStyleLine(lines);
    const lineTexts = extractLineTexts(lines, explicitTextLines);
    return [
      {
        confidence: block.confidence,
        color: block.color,
        id,
        kind: block.kind,
        lineCount,
        lines: lineTexts,
        lineRegions,
        region,
        styleRegion: styleLine?.region,
        styleText: styleLine?.text,
        text,
        visualRegion,
      },
    ];
  });

const createModuleTextStyleHints = async ({
  moduleDir,
  moduleId,
  scale,
  textBlocksFile,
}: {
  moduleDir: string;
  moduleId: string;
  scale?: number;
  textBlocksFile: ModuleTextBlocksFile;
}): Promise<ModuleTextStyleHintsFile> => {
  const resolvedTextBlocksFile = textBlocksFile;
  const textBlocks = normalizeModuleTextBlocks(resolvedTextBlocksFile);
  const previewPath = resolveMaybeRelative(
    moduleDir,
    resolvedTextBlocksFile.previewPath,
  );

  if (!textBlocks.length) {
    const payload: ModuleTextStyleHintsFile = {
      blockCount: 0,
      blocks: [],
      generatedAt: new Date().toISOString(),
      generatedBy: "text-style-inference",
      moduleId,
      previewPath,
    };
    return payload;
  }

  const inferenceBlocks: TextStyleInferenceInputBlock[] = textBlocks.map(
    (block) => {
      const hasExplicitLines = block.lines.length > 1;
      const usesSingleStyleLine = !hasExplicitLines && Boolean(block.styleRegion && block.styleText);
      const region = usesSingleStyleLine ? block.styleRegion! : block.region;
      const lineCount = usesSingleStyleLine ? 1 : block.lineCount;
      const lineHeight =
        block.lineRegions.length > 1 && block.styleRegion
          ? estimateMultilineLineHeight(block.lineRegions, block.styleRegion.height)
          : (typeof lineCount === 'number' && lineCount > 1)
            ? Math.round(region.height / lineCount)
            : block.region.height;
      return {
        color: block.color,
        id: block.id,
        lineCount,
        lineHeight,
        lines: hasExplicitLines ? block.lines : undefined,
        region,
        renderScale: scale ?? 1,
        text: block.styleText ?? block.text,
        visualRegion: hasExplicitLines
          ? region
          : usesSingleStyleLine
          ? block.styleRegion
          : block.visualRegion ?? block.region,
      };
    },
  );
  const recommendations = await inferTextStyles({
    blocks: inferenceBlocks,
    deviceScaleFactor: scale,
    targetImagePath:
      previewPath && existsSync(previewPath) ? previewPath : undefined,
  });
  const recommendationById = new Map(
    recommendations.map((recommendation) => [
      recommendation.id,
      recommendation,
    ]),
  );
  const blocks = textBlocks.flatMap((block): ModuleTextStyleHint[] => {
    const recommendation = recommendationById.get(block.id);
    if (!recommendation) return [];
    return [
      {
        confidence: block.confidence,
        declarations: recommendation.declarations,
        fit: recommendation.fit,
        id: block.id,
        kind: block.kind,
        lineCount: block.lineCount,
        lineRegions: block.lineRegions.length ? block.lineRegions : undefined,
        region: block.region,
        text: block.text,
      },
    ];
  });
  const payload: ModuleTextStyleHintsFile = {
    blockCount: blocks.length,
    blocks,
    generatedAt: new Date().toISOString(),
    generatedBy: "text-style-inference",
    moduleId,
    previewPath,
  };
  return payload;
};

export type { ModuleTextStyleHintsFile };
export { createModuleTextStyleHints };
