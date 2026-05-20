import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge, shutdownBrowserPool } from "../core/cdp.js";
import {
  inferTextStyles,
  type TextStyleInferenceInputBlock,
} from "../core/text-style-inference.js";
import {
  toAbsolutePath,
  writeJsonFile,
} from "../core/utils.js";

type TextLayoutBlock = {
  declarations?: Record<string, string>;
  id?: string;
  region?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  selectors?: string[];
};

type TextLayoutConfig = {
  blocks?: TextLayoutBlock[];
  rules?: unknown[];
};

type OcrBlock = {
  bbox?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  id?: string;
  text?: string;
};

type ModuleTextBlock = {
  color?: string;
  id?: string;
  region?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  text?: string;
  textRegion?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
};

type OcrBlockFile =
  | Array<ModuleTextBlock | OcrBlock>
  | {
      blocks?: Array<ModuleTextBlock | OcrBlock>;
      previewPath?: string;
      region?: {
        height: number;
        width: number;
        x: number;
        y: number;
      };
    };

const parseArgs = (args: string[]) => {
  let textLayoutPath: string | undefined;
  let ocrBlocksPath: string | undefined;
  let outputPath: string | undefined;
  let htmlPath: string | undefined;
  let textBlocksPath: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--ocr") {
      ocrBlocksPath = args[++index];
      continue;
    }
    if (arg.startsWith("--ocr=")) {
      ocrBlocksPath = arg.slice("--ocr=".length);
      continue;
    }
    if (arg === "--out") {
      outputPath = args[++index];
      continue;
    }
    if (arg.startsWith("--out=")) {
      outputPath = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--html") {
      htmlPath = args[++index];
      continue;
    }
    if (arg.startsWith("--html=")) {
      htmlPath = arg.slice("--html=".length);
      continue;
    }
    if (arg === "--text-blocks" || arg === "--textBlocks") {
      textBlocksPath = args[++index];
      continue;
    }
    if (arg.startsWith("--text-blocks=")) {
      textBlocksPath = arg.slice("--text-blocks=".length);
      continue;
    }
    if (arg.startsWith("--textBlocks=")) {
      textBlocksPath = arg.slice("--textBlocks=".length);
      continue;
    }
    if (!arg.startsWith("-") && !textLayoutPath) {
      textLayoutPath = arg;
    }
  }

  if (!textLayoutPath) {
    throw new Error(
      "Usage: pnpm exec tsx src/cli/infer-text-style.ts path/to/text-layout.json --ocr path/to/module-ocr-blocks.json [--out report.json] [--apply]",
    );
  }

  return { apply, htmlPath, ocrBlocksPath, outputPath, textBlocksPath, textLayoutPath };
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(toAbsolutePath(filePath), "utf8")) as T;

const normalizeOcrBlocks = (input: OcrBlockFile) =>
  (Array.isArray(input) ? input : input.blocks ?? []).filter(
    (block): block is Required<Pick<OcrBlock, "id" | "text">> & OcrBlock =>
      typeof block.id === "string" && typeof block.text === "string",
  );

const normalizeTextBlocks = (input: OcrBlockFile) =>
  (Array.isArray(input) ? input : input.blocks ?? []).filter(
    (block): block is Required<Pick<ModuleTextBlock, "id" | "text">> &
      ModuleTextBlock =>
      typeof block.id === "string" && typeof block.text === "string",
  );

const getPreviewPath = (input: OcrBlockFile) =>
  !Array.isArray(input) && typeof input.previewPath === "string"
    ? input.previewPath
    : undefined;

const getModuleRegion = (input: OcrBlockFile) =>
  !Array.isArray(input) &&
  isRegion(input.region) &&
  input.region.width > 0 &&
  input.region.height > 0
    ? input.region
    : undefined;

const readPngSize = async (filePath: string) => {
  const buffer = await readFile(filePath);
  if (
    buffer.length < 24 ||
    buffer.toString("ascii", 1, 4) !== "PNG" ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return undefined;
  }
  return {
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  };
};

type LayoutRegion = NonNullable<TextLayoutBlock["region"]>;

const areaOf = (box: LayoutRegion) => Math.max(0, box.width) * Math.max(0, box.height);

const intersectionArea = (left: LayoutRegion, right: LayoutRegion) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

const centerDistance = (left: LayoutRegion, right: LayoutRegion) => {
  const leftX = left.x + left.width / 2;
  const leftY = left.y + left.height / 2;
  const rightX = right.x + right.width / 2;
  const rightY = right.y + right.height / 2;
  return Math.hypot(leftX - rightX, leftY - rightY);
};

const isRegion = (value: unknown): value is LayoutRegion => {
  if (!value || typeof value !== "object") return false;
  const box = value as Partial<LayoutRegion>;
  return (
    isFiniteNumber(box.x) &&
    isFiniteNumber(box.y) &&
    isFiniteNumber(box.width) &&
    isFiniteNumber(box.height)
  );
};

const getTextBlockRegion = (block: ModuleTextBlock) => {
  if (isRegion(block.textRegion)) return block.textRegion;
  if (isRegion(block.region)) return block.region;
  return undefined;
};

const getTextBlockStyleRegion = (block: ModuleTextBlock) => {
  if (isRegion(block.region)) return block.region;
  if (isRegion(block.textRegion)) return block.textRegion;
  return undefined;
};

const scaleRegion = (region: LayoutRegion, scale: number): LayoutRegion => ({
  height: region.height * scale,
  width: region.width * scale,
  x: region.x * scale,
  y: region.y * scale,
});

const findTextBlockByRegion = ({
  block,
  textBlocks,
}: {
  block: TextLayoutBlock & { region: LayoutRegion };
  textBlocks: ModuleTextBlock[];
}): {
  block: ModuleTextBlock;
  rawRegion: LayoutRegion;
  region: LayoutRegion;
  scale: number;
} | undefined => {
  const candidates = textBlocks.flatMap((candidate) => {
    const baseRegion = getTextBlockRegion(candidate);
    if (!baseRegion || !candidate.text) return [];
    return [1, 2, 0.5].map((scale) => {
      const region = scale === 1 ? baseRegion : scaleRegion(baseRegion, scale);
      const overlap = intersectionArea(block.region, region);
      const minArea = Math.max(1, Math.min(areaOf(block.region), areaOf(region)));
      const maxArea = Math.max(1, Math.max(areaOf(block.region), areaOf(region)));
      const overlapRatio = overlap / minArea;
      const areaRatio = minArea / maxArea;
      const distance = centerDistance(block.region, region);
      const maxDimension = Math.max(
        block.region.width,
        block.region.height,
        region.width,
        region.height,
        1,
      );
      const distanceRatio = distance / maxDimension;
      const score = overlapRatio * 3 + areaRatio - distanceRatio - (scale === 1 ? 0 : 0.05);
      return {
        block: candidate,
        rawRegion: baseRegion,
        region,
        score,
        scale,
        overlapRatio,
      };
    });
  });
  const match = candidates
    .filter((candidate) => candidate.overlapRatio >= 0.25 || candidate.score > 0.9)
    .sort((left, right) => right.score - left.score)[0];
  return match
    ? {
        block: match.block,
        rawRegion: match.rawRegion,
        region: match.region,
        scale: match.scale,
      }
    : undefined;
};

const readHtmlTextByBlockId = async ({
  htmlPath,
  layout,
}: {
  htmlPath: string;
  layout: TextLayoutConfig;
}) => {
  const browser = await launchEdge();
  try {
    return await evaluatePage<Record<string, string>>({
      expression: `(() => {
        const blocks = ${JSON.stringify(layout.blocks ?? [])};
        const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
        const output = {};
        blocks.forEach((block) => {
          if (!block || typeof block.id !== 'string' || !Array.isArray(block.selectors)) return;
          for (const selector of block.selectors) {
            if (typeof selector !== 'string') continue;
            const element = document.querySelector(selector);
            const text = element ? normalize(element.textContent) : '';
            if (text) {
              output[block.id] = text;
              break;
            }
          }
        });
        return output;
      })()`,
      port: browser.port,
      readyExpression: "document.readyState === 'complete'",
      url: pathToFileURL(toAbsolutePath(htmlPath)).href,
      viewportHeight: 800,
      viewportWidth: 1200,
    });
  } finally {
    await browser.close();
  }
};

const createInferenceBlocks = ({
  htmlTextById,
  imageScale,
  layout,
  ocrBlocks,
  targetImageSize,
  textBlocks,
}: {
  htmlTextById?: Map<string, string>;
  imageScale?: number;
  layout: TextLayoutConfig;
  ocrBlocks: OcrBlock[];
  targetImageSize?: { height: number; width: number };
  textBlocks: ModuleTextBlock[];
}): TextStyleInferenceInputBlock[] => {
  const textById = new Map(
    ocrBlocks.flatMap((block) =>
      typeof block.id === "string" && typeof block.text === "string"
        ? [[block.id, block.text] as const]
        : [],
    ),
  );
  const confirmedById = new Map(
    textBlocks.flatMap((block) =>
      typeof block.id === "string" && typeof block.text === "string"
        ? [[block.id, block] as const]
        : [],
    ),
  );

  return (layout.blocks ?? []).flatMap((block) => {
    if (
      !block.id ||
      !block.region ||
      !isFiniteNumber(block.region.x) ||
      !isFiniteNumber(block.region.y) ||
      !isFiniteNumber(block.region.width) ||
      !isFiniteNumber(block.region.height)
    ) {
      return [];
    }
    const directConfirmed = confirmedById.get(block.id);
    const regionMatched = directConfirmed
      ? undefined
      : findTextBlockByRegion({
        block: block as TextLayoutBlock & { region: LayoutRegion },
        textBlocks,
      });
    const confirmed = directConfirmed ?? regionMatched?.block;
    const text = confirmed?.text ?? htmlTextById?.get(block.id) ?? textById.get(block.id);
    const matchScale = regionMatched?.scale ?? 1;
    const rawVisualRegion =
      directConfirmed && getTextBlockRegion(directConfirmed)
        ? getTextBlockRegion(directConfirmed)
        : regionMatched?.rawRegion;
    const rawStyleRegion =
      directConfirmed && getTextBlockStyleRegion(directConfirmed)
        ? getTextBlockStyleRegion(directConfirmed)
        : rawVisualRegion;
    const imageRegion =
      targetImageSize && textBlocks.length === 1
        ? { height: targetImageSize.height, width: targetImageSize.width, x: 0, y: 0 }
        : undefined;
    const styleRegionCoverage =
      rawStyleRegion && imageRegion
        ? intersectionArea(rawStyleRegion, imageRegion) /
          Math.max(1, Math.min(areaOf(rawStyleRegion), areaOf(imageRegion)))
        : 0;
    const expandedStyleRegion =
      rawStyleRegion &&
      imageRegion &&
      styleRegionCoverage >= 0.8 &&
      rawStyleRegion.width >= imageRegion.width * 0.75 &&
      rawStyleRegion.height >= imageRegion.height * 0.75
        ? imageRegion
        : rawStyleRegion;
    const styleMetricWeight =
      expandedStyleRegion && imageRegion && expandedStyleRegion === imageRegion
        ? 10
        : 0;
    const confirmedRegion = expandedStyleRegion
      ? scaleRegion(expandedStyleRegion, directConfirmed ? 1 : matchScale)
      : undefined;
    const visualRegion =
      rawVisualRegion && imageScale
        ? scaleRegion(rawVisualRegion, (directConfirmed ? 1 : matchScale) * imageScale)
        : undefined;
    if (!text) return [];
    return [
      {
        currentDeclarations: block.declarations ?? {},
        color: confirmed?.color,
        id: block.id,
        lineHeight:
          typeof block.declarations?.["line-height"] === "string"
            ? Number.parseFloat(block.declarations["line-height"])
            : block.region.height,
        region: confirmedRegion ?? block.region,
        renderScale: imageScale,
        styleMetricWeight,
        text,
        visualRegion,
      },
    ];
  });
};

const applyRecommendations = ({
  layout,
  recommendations,
}: {
  layout: TextLayoutConfig;
  recommendations: Awaited<ReturnType<typeof inferTextStyles>>;
}) => {
  const recommendationById = new Map(
    recommendations.map((recommendation) => [recommendation.id, recommendation]),
  );
  return {
    ...layout,
    blocks: (layout.blocks ?? []).map((block) => {
      if (!block.id) return block;
      const recommendation = recommendationById.get(block.id);
      if (!recommendation) return block;
      return {
        ...block,
        declarations: {
          ...(block.declarations ?? {}),
          ...recommendation.declarations,
        },
      };
    }),
  } satisfies TextLayoutConfig;
};

const main = async () => {
  const { apply, htmlPath, ocrBlocksPath, outputPath, textBlocksPath, textLayoutPath } =
    parseArgs(process.argv.slice(2));
  const layoutAbsPath = toAbsolutePath(textLayoutPath);
  const resolvedOcrBlocksPath =
    ocrBlocksPath ??
    path.join(path.dirname(layoutAbsPath), "module-ocr-blocks.json");
  const resolvedTextBlocksPath =
    textBlocksPath ?? path.join(path.dirname(layoutAbsPath), "module-text-blocks.json");
  const layout = await readJson<TextLayoutConfig>(layoutAbsPath);
  const ocrBlocks = normalizeOcrBlocks(
    await readJson<OcrBlockFile>(resolvedOcrBlocksPath),
  );
  const textBlocksFile = await readJson<OcrBlockFile>(resolvedTextBlocksPath).catch(
    () => [] as OcrBlockFile,
  );
  const textBlocks = normalizeTextBlocks(textBlocksFile);
  const targetImagePath = getPreviewPath(textBlocksFile);
  const resolvedTargetImagePath = targetImagePath
    ? path.resolve(path.dirname(toAbsolutePath(resolvedTextBlocksPath)), targetImagePath)
    : undefined;
  const moduleRegion = getModuleRegion(textBlocksFile);
  const targetImageSize = resolvedTargetImagePath
    ? await readPngSize(resolvedTargetImagePath).catch(() => undefined)
    : undefined;
  const imageScale =
    moduleRegion && targetImageSize
      ? Math.min(targetImageSize.width / moduleRegion.width, targetImageSize.height / moduleRegion.height)
      : targetImageSize
        ? 1
        : undefined;
  const htmlTextById = htmlPath
    ? new Map(
        Object.entries(
          await readHtmlTextByBlockId({
            htmlPath,
            layout,
          }),
        ),
      )
    : undefined;
  const inferenceBlocks = createInferenceBlocks({
    htmlTextById,
    imageScale,
    layout,
    ocrBlocks,
    targetImageSize,
    textBlocks,
  });

  if (!inferenceBlocks.length) {
    throw new Error(
      `No text-layout blocks matched OCR text: ${layoutAbsPath}, ${resolvedOcrBlocksPath}`,
    );
  }

  const recommendations = await inferTextStyles({
    blocks: inferenceBlocks,
    targetImagePath: resolvedTargetImagePath,
  });
  const report = {
    blockCount: recommendations.length,
    generatedAt: new Date().toISOString(),
    htmlPath: htmlPath ? toAbsolutePath(htmlPath) : undefined,
    ocrBlocksPath: toAbsolutePath(resolvedOcrBlocksPath),
    recommendations,
    targetImagePath: resolvedTargetImagePath,
    textBlocksPath: textBlocks.length ? toAbsolutePath(resolvedTextBlocksPath) : undefined,
    textLayoutPath: layoutAbsPath,
  };
  const reportPath =
    outputPath ??
    path.join(path.dirname(layoutAbsPath), "text-style-inference.json");
  await writeJsonFile(toAbsolutePath(reportPath), report);

  if (apply) {
    await writeJsonFile(
      layoutAbsPath,
      applyRecommendations({ layout, recommendations }),
    );
  }

  console.log(
    JSON.stringify({
      applied: apply,
      blockCount: recommendations.length,
      reportPath: toAbsolutePath(reportPath),
      textLayoutPath: layoutAbsPath,
    }),
  );
};

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownBrowserPool();
  });
