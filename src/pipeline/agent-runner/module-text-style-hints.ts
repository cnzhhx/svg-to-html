import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  inferTextStyles,
  type TextStyleInferenceInputBlock,
  type TextStyleInferenceRecommendation,
} from "../../core/text-style-inference.js";
import type { Box } from "../../core/utils.js";
import { writeJsonFile } from "../../core/utils.js";

type TextLayoutBlock = {
  declarations?: Record<string, string>;
  id?: string;
  region?: Box;
  selectors?: string[];
};

type TextLayoutConfig = {
  blocks?: TextLayoutBlock[];
  rules?: unknown[];
};

type ModuleTextBlock = {
  confidence?: number;
  id?: string;
  kind?: string;
  region?: Box;
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
  textBlocksPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

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
    return [
      {
        confidence: block.confidence,
        id,
        kind: block.kind,
        region,
        text,
      },
    ];
  });

const createModuleTextStyleHints = async ({
  moduleDir,
  moduleId,
  moduleTextBlocksPath,
  outputPath = path.join(moduleDir, "module-text-style-hints.json"),
}: {
  moduleDir: string;
  moduleId: string;
  moduleTextBlocksPath: string;
  outputPath?: string;
}): Promise<ModuleTextStyleHintsFile> => {
  const textBlocksFile =
    await readJson<ModuleTextBlocksFile>(moduleTextBlocksPath);
  const textBlocks = normalizeModuleTextBlocks(textBlocksFile);
  const previewPath = resolveMaybeRelative(
    moduleDir,
    textBlocksFile.previewPath,
  );

  if (!textBlocks.length) {
    const payload: ModuleTextStyleHintsFile = {
      blockCount: 0,
      blocks: [],
      generatedAt: new Date().toISOString(),
      generatedBy: "text-style-inference",
      moduleId,
      previewPath,
      textBlocksPath: moduleTextBlocksPath,
    };
    await writeJsonFile(outputPath, payload);
    return payload;
  }

  const inferenceBlocks: TextStyleInferenceInputBlock[] = textBlocks.map(
    (block) => ({
      id: block.id,
      lineHeight: block.region.height,
      region: block.region,
      text: block.text,
      visualRegion: block.region,
    }),
  );
  const recommendations = await inferTextStyles({
    blocks: inferenceBlocks,
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
    textBlocksPath: moduleTextBlocksPath,
  };
  await writeJsonFile(outputPath, payload);
  return payload;
};

const areaOf = (box: Box) => Math.max(0, box.width) * Math.max(0, box.height);

const intersectionArea = (left: Box, right: Box) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

const findHintByRegion = (
  block: TextLayoutBlock,
  hints: ModuleTextStyleHint[],
) => {
  if (!block.region) return undefined;
  return hints
    .map((hint) => {
      const overlap = intersectionArea(block.region!, hint.region);
      const minArea = Math.max(
        1,
        Math.min(areaOf(block.region!), areaOf(hint.region)),
      );
      return {
        hint,
        overlapRatio: overlap / minArea,
      };
    })
    .filter((candidate) => candidate.overlapRatio >= 0.5)
    .sort((left, right) => right.overlapRatio - left.overlapRatio)[0]?.hint;
};

const hasFontDeclarations = (declarations: Record<string, string>) =>
  Boolean(declarations["font-size"] || declarations["font-weight"]);

const applyModuleTextStyleHintsToLayout = async ({
  hintsPath,
  textLayoutPath,
}: {
  hintsPath: string;
  textLayoutPath: string;
}) => {
  const [layout, hintsFile] = await Promise.all([
    readJson<TextLayoutConfig>(textLayoutPath),
    readJson<ModuleTextStyleHintsFile>(hintsPath),
  ]);
  const hints = Array.isArray(hintsFile.blocks) ? hintsFile.blocks : [];
  const hintById = new Map(hints.map((hint) => [hint.id, hint]));
  let appliedBlockCount = 0;
  const nextBlocks = (layout.blocks ?? []).map((block) => {
    const declarations = { ...(block.declarations ?? {}) };
    const hint =
      (block.id ? hintById.get(block.id) : undefined) ??
      findHintByRegion(block, hints);
    const needsHint = hint && !hasFontDeclarations(declarations);
    if (!needsHint) {
      return {
        ...block,
        declarations,
      };
    }
    appliedBlockCount += 1;
    return {
      ...block,
      declarations: {
        ...hint.declarations,
        ...declarations,
      },
    };
  });
  await writeJsonFile(textLayoutPath, {
    ...layout,
    blocks: nextBlocks,
  });
  return {
    appliedBlockCount,
    hintCount: hints.length,
  };
};

export type { ModuleTextStyleHint, ModuleTextStyleHintsFile };
export { applyModuleTextStyleHintsToLayout, createModuleTextStyleHints };
