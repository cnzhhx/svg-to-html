import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { capturePage, evaluatePage, launchEdge } from "./cdp.js";
import { areaOf, intersectionArea } from "./geometry.js";
import type { Box, Region } from './geometry.js';
import { isRecord } from './type-guards.js';
import { parseSvgSize } from './svg-parse.js';
import { writeTextFile } from './file-io.js';

type ModuleTextBlock = {
  bboxIncludesIcon?: boolean;
  color?: string;
  confidence?: number;
  geometrySource?: "semantic" | "svg-render-refined";
  id: string;
  kind?: string;
  lineCount?: number;
  lineRegions?: Box[];
  lines?: Array<{ region?: Box; text?: string }>;
  notes?: string;
  renderedTextRegion?: Box;
  region: Box;
  source?: "semantic";
  sourceBlockId?: string;
  sourceBlockText?: string;
  text: string;
  textRegion?: Box;
};

type ModuleTextBlocksFile = {
  blockCount: number;
  blocks: ModuleTextBlock[];
  coordinateSpace: "local";
  generatedAt: string;
  generatedBy: "semantic-text-extract";
  moduleId: string;
  previewPath?: string;
  region: Region;
};

type SemanticTextHint = {
  bbox?: Box;
  color?: string;
  confidence?: number;
  id?: string;
  lineCount?: number;
  lines?: string[];
  role?: string;
  text?: string;
};

const createSvgDomWrapper = ({
  height,
  svgMarkup,
  width,
}: {
  height: number;
  svgMarkup: string;
  width: number;
}) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
      svg { display: block; width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>
    ${svgMarkup}
  </body>
</html>`;

const readSvgPaintCandidatesFromDom = async (
  svgPath: string,
  scale?: number,
  port?: number,
): Promise<Array<{ box: Box; color: string }>> => {
  const safeScale = scale ?? 1;
  const { height, width } = await parseSvgSize(svgPath, scale);
  const svgMarkup = await readFile(svgPath, "utf8");
  const wrapperPath = path.join(
    path.dirname(svgPath),
    ".svg-paint-candidates.html",
  );
  await writeTextFile(
    wrapperPath,
    createSvgDomWrapper({ height, svgMarkup, width }),
  );
  const browser = port === undefined ? await launchEdge() : undefined;
  const activePort = port ?? browser!.port;
  try {
    const candidates = await evaluatePage<
      Array<{ box: Box; color: string }>
    >({
      deviceScaleFactor: scale,
      expression: `(() => {
        const svg = document.querySelector('svg');
        if (!svg) return [];
        const rootRect = svg.getBoundingClientRect();
        const resourceSelector = "defs,mask,clipPath,pattern,linearGradient,radialGradient,filter,marker,symbol,style";
        const candidateSelector = "path,text,tspan,g,rect,circle,ellipse,line,polyline,polygon";
        const result = [];
        for (const el of svg.querySelectorAll(candidateSelector)) {
          if (el.closest(resourceSelector)) continue;
          const fill = el.getAttribute('fill')?.trim();
          if (!fill || fill === 'none' || /^url\\(/i.test(fill)) continue;
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          result.push({
            box: {
              x: Number((rect.left - rootRect.left).toFixed(3)),
              y: Number((rect.top - rootRect.top).toFixed(3)),
              width: Number(rect.width.toFixed(3)),
              height: Number(rect.height.toFixed(3)),
            },
            color: fill,
          });
        }
        return result;
      })()`,
      port: activePort,
      readyExpression: "true",
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: height,
      viewportWidth: width,
    });
    return candidates.map((candidate) => ({
      box: {
        x: Number((candidate.box.x / safeScale).toFixed(3)),
        y: Number((candidate.box.y / safeScale).toFixed(3)),
        width: Number((candidate.box.width / safeScale).toFixed(3)),
        height: Number((candidate.box.height / safeScale).toFixed(3)),
      },
      color: candidate.color,
    }));
  } finally {
    if (browser) {
      await browser.close();
    }
    try {
      await rm(wrapperPath);
    } catch {}
  }
};

const createSvgImageWrapper = ({
  height,
  svgPath,
  width,
}: {
  height: number;
  svgPath: string;
  width: number;
}) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
      img { display: block; width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>
    <img src="${pathToFileURL(svgPath).href}" alt="" />
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => {
          window.__RENDER_READY__ = true
        }, 300)
      })
    </script>
  </body>
</html>`;

const renderModuleSvgPreview = async ({
  moduleDir,
  moduleSvgPath,
  scale,
  port: externalPort,
}: {
  moduleDir: string;
  moduleSvgPath: string;
  scale?: number;
  port?: number;
}) => {
  const { height, width } = await parseSvgSize(moduleSvgPath, scale);
  const wrapperPath = path.join(moduleDir, "module-text-source.html");
  const previewPath = path.join(moduleDir, "module-text-source.png");
  await writeTextFile(
    wrapperPath,
    createSvgImageWrapper({ height, svgPath: moduleSvgPath, width }),
  );
  const browser = externalPort === undefined ? await launchEdge() : undefined;
  const port = externalPort ?? browser!.port;
  try {
    await capturePage({
      deviceScaleFactor: scale,
      outputPath: previewPath,
      port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: height,
      viewportWidth: width,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  return { height, previewPath, width };
};

const getNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readBox = (value: unknown): Box | undefined => {
  if (!isRecord(value)) return undefined;
  const x = getNumber(value["x"]);
  const y = getNumber(value["y"]);
  const width = getNumber(value["width"]);
  const height = getNumber(value["height"]);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { height, width, x, y };
};

const readColor = (value: unknown) => {
  const color = typeof value === "string" ? value.trim() : "";
  if (!color) return undefined;
  const normalized = color.toLowerCase();
  if (
    normalized === "none" ||
    normalized === "transparent" ||
    normalized.startsWith("url(")
  ) {
    return undefined;
  }
  return color;
};

const normalizeInlineText = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const readSemanticTextLines = (
  value: unknown,
): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item !== "string") return [];
        const text = normalizeInlineText(item);
        return text ? [text] : [];
      })
    : [];

const joinSemanticTextLines = (lines: string[]) =>
  lines.join("\n");

const roundedBox = (box: Box): Box => ({
  height: Math.max(1, Math.round(box.height)),
  width: Math.max(1, Math.round(box.width)),
  x: Math.round(box.x),
  y: Math.round(box.y),
});

const appendNote = (notes: string | undefined, note: string) =>
  notes ? `${notes}; ${note}` : note;

const refineTextRegionsFromSvgRender = async ({
  blocks,
  previewPath,
  scale,
  port: externalPort,
}: {
  blocks: ModuleTextBlock[];
  previewPath: string;
  scale?: number;
  port?: number;
}): Promise<ModuleTextBlock[]> => {
  const safeScale = scale ?? 1;
  const inputs = blocks.flatMap((block) => {
    const seed = block.textRegion ?? block.region;
    return seed
      ? [
          {
            id: block.id,
            seed: {
              x: seed.x * safeScale,
              y: seed.y * safeScale,
              width: seed.width * safeScale,
              height: seed.height * safeScale,
            },
          },
        ]
      : [];
  });
  if (!inputs.length) return blocks;

  const browser = externalPort === undefined ? await launchEdge() : undefined;
  const port = externalPort ?? browser!.port;
  try {
    const refined = await evaluatePage<
      Array<{ box?: Box; id: string; refined: boolean }>
    >({
      deviceScaleFactor: scale,
      expression: `(async () => {
        const imageUrl = ${JSON.stringify(pathToFileURL(previewPath).href)};
        const inputs = ${JSON.stringify(inputs)};
        const image = await new Promise((resolve, reject) => {
          const item = new Image();
          item.onload = () => resolve(item);
          item.onerror = () => reject(new Error('Unable to load text source image: ' + imageUrl));
          item.src = imageUrl;
        });
        const imageWidth = Number(image.naturalWidth || image.width || 0);
        const imageHeight = Number(image.naturalHeight || image.height || 0);
        const canvas = document.createElement('canvas');
        canvas.width = imageWidth;
        canvas.height = imageHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return inputs.map((input) => ({ id: input.id, refined: false }));
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, imageWidth, imageHeight).data;
        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
        const median = (values) => {
          if (!values.length) return 0;
          values.sort((left, right) => left - right);
          return values[Math.floor(values.length / 2)] ?? 0;
        };
        const percentile = (values, ratio) => {
          if (!values.length) return 0;
          values.sort((left, right) => left - right);
          return values[Math.floor((values.length - 1) * ratio)] ?? 0;
        };
        const pixel = (x, y) => {
          const index = (y * imageWidth + x) * 4;
          return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
        };
        const colorDistance = (left, right) =>
          Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
        const normalizeBox = (box) => {
          const x = clamp(Math.floor(Number(box.x ?? 0)), 0, Math.max(0, imageWidth - 1));
          const y = clamp(Math.floor(Number(box.y ?? 0)), 0, Math.max(0, imageHeight - 1));
          const width = clamp(Math.ceil(Number(box.width ?? 0)), 1, imageWidth - x);
          const height = clamp(Math.ceil(Number(box.height ?? 0)), 1, imageHeight - y);
          return { x, y, width, height };
        };
        const expandBox = (box, padding) => {
          const x = clamp(box.x - padding, 0, Math.max(0, imageWidth - 1));
          const y = clamp(box.y - padding, 0, Math.max(0, imageHeight - 1));
          const right = clamp(box.x + box.width + padding, x + 1, imageWidth);
          const bottom = clamp(box.y + box.height + padding, y + 1, imageHeight);
          return { x, y, width: right - x, height: bottom - y };
        };
        const estimateBackground = (box) => {
          const red = [];
          const green = [];
          const blue = [];
          const sample = (x, y) => {
            const item = pixel(x, y);
            red.push(item[0]);
            green.push(item[1]);
            blue.push(item[2]);
          };
          for (let x = box.x; x < box.x + box.width; x += 1) {
            sample(x, box.y);
            sample(x, box.y + box.height - 1);
          }
          for (let y = box.y + 1; y < box.y + box.height - 1; y += 1) {
            sample(box.x, y);
            sample(box.x + box.width - 1, y);
          }
          return [median(red), median(green), median(blue)];
        };
        const refine = (seedInput) => {
          const seed = normalizeBox(seedInput);
          const padding = Math.max(2, Math.min(8, Math.round(Math.max(seed.width, seed.height) * 0.18)));
          const sampleBox = expandBox(seed, padding);
          const background = estimateBackground(sampleBox);
          const distances = [];
          for (let y = seed.y; y < seed.y + seed.height; y += 1) {
            for (let x = seed.x; x < seed.x + seed.width; x += 1) {
              distances.push(colorDistance(pixel(x, y), background));
            }
          }
          const threshold = Math.max(10, percentile(distances, 0.72) * 0.62);
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let ink = 0;
          for (let y = seed.y; y < seed.y + seed.height; y += 1) {
            for (let x = seed.x; x < seed.x + seed.width; x += 1) {
              if (colorDistance(pixel(x, y), background) < threshold) continue;
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x + 1);
              maxY = Math.max(maxY, y + 1);
              ink += 1;
            }
          }
          const minInk = Math.max(4, Math.min(24, Math.round(seed.width * seed.height * 0.015)));
          if (!Number.isFinite(minX) || ink < minInk) return undefined;
          const box = {
            height: Math.max(1, maxY - minY),
            width: Math.max(1, maxX - minX),
            x: minX,
            y: minY,
          };
          const tooSmall =
            box.width < Math.max(2, seed.width * 0.25) ||
            box.height < Math.max(2, seed.height * 0.35);
          return tooSmall ? undefined : box;
        };
        return inputs.map((input) => {
          const box = refine(input.seed);
          return box
            ? { box, id: input.id, refined: true }
            : { id: input.id, refined: false };
        });
      })()`,
      port,
      readyExpression: "true",
      url: pathToFileURL(process.cwd()).href,
      viewportHeight: 100,
      viewportWidth: 100,
    });

    const refinedById = new Map(refined.map((item) => [item.id, item]));
    return blocks.map((block) => {
      const item = refinedById.get(block.id);
      if (!item?.box) {
        return {
          ...block,
          geometrySource: block.geometrySource ?? "semantic",
        };
      }
      const rawBox = {
        x: item.box.x / safeScale,
        y: item.box.y / safeScale,
        width: item.box.width / safeScale,
        height: item.box.height / safeScale,
      };
      const box = roundedBox(rawBox);
      return {
        ...block,
        geometrySource: "svg-render-refined" as const,
        notes: appendNote(
          block.notes,
          "renderedTextRegion refined from SVG render foreground pixels",
        ),
        renderedTextRegion: box,
      };
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

const attachSvgColors = async ({
  blocks,
  moduleSvgPath,
  scale,
  port,
}: {
  blocks: ModuleTextBlock[];
  moduleSvgPath: string;
  scale?: number;
  port?: number;
}) => {
  const candidates = await readSvgPaintCandidatesFromDom(
    moduleSvgPath,
    scale,
    port,
  ).catch(() => []);
  if (!candidates.length) return blocks;
  const globalColor =
    candidates.length === 1 ||
    candidates.every((candidate) => candidate.color === candidates[0]?.color)
      ? candidates[0]?.color
      : undefined;
  return blocks.map((block) => {
    if (readColor(block.color)) return block;
    const region = block.textRegion ?? block.region;
    const matched = candidates
      .flatMap((candidate) => {
        const overlap = intersectionArea(region, candidate.box);
        const ratio =
          overlap /
          Math.max(1, Math.min(areaOf(region), areaOf(candidate.box)));
        return [{ area: areaOf(candidate.box), color: candidate.color, ratio }];
      })
      .filter((candidate) => candidate.ratio >= 0.2)
      .sort(
        (left, right) =>
          right.ratio - left.ratio ||
          left.area - right.area,
      )[0];
    const color = matched?.color ?? globalColor;
    return color ? { ...block, color } : block;
  });
};

const buildSemanticBlocks = (hints: SemanticTextHint[]) =>
  hints.flatMap((hint, index): ModuleTextBlock[] => {
    const lines = Array.isArray(hint.lines) ? hint.lines : [];
    const text = lines.length
      ? joinSemanticTextLines(lines)
      : typeof hint.text === "string"
        ? hint.text.trim()
        : "";
    if (!text || !hint.bbox) return [];
    return [
      {
        color: hint.color,
        confidence:
          typeof hint.confidence === "number" ? hint.confidence : undefined,
        geometrySource: "semantic",
        id: hint.id ?? `semantic-text-${index + 1}`,
        kind: hint.role,
        lineCount: lines.length || hint.lineCount,
        ...(lines.length
          ? { lines: lines.map((text) => ({ text })) }
          : {}),
        region: hint.bbox,
        source: "semantic",
        sourceBlockId: hint.id,
        sourceBlockText: text,
        text,
        textRegion: hint.bbox,
      },
    ];
  });

const createModuleTextBlocks = async ({
  moduleDir,
  moduleId,
  textHints,
  moduleSvgPath,
  region,
  scale,
}: {
  moduleDir: string;
  moduleId: string;
  textHints?: unknown;
  moduleSvgPath: string;
  region: Region;
  scale?: number;
}): Promise<ModuleTextBlocksFile> => {
  const rawHints = textHints ?? {};
  const hints = (
    isRecord(rawHints) && Array.isArray(rawHints["blocks"]) ? rawHints["blocks"] : []
  ).flatMap((block): SemanticTextHint[] => {
    if (!isRecord(block)) return [];
    return [
      {
        bbox: readBox(block["bbox"]),
        color:
          readColor(block["color"]) ??
          readColor(block["textColor"]) ??
          readColor(block["foregroundColor"]),
        confidence: getNumber(block["confidence"]),
        id: typeof block["id"] === "string" ? block["id"] : undefined,
        lineCount: getNumber(block["lineCount"]),
        lines: readSemanticTextLines(block["lines"]),
        role: typeof block["role"] === "string" ? block["role"] : undefined,
        text: typeof block["text"] === "string" ? block["text"] : undefined,
      },
    ];
  });
  const browser = await launchEdge();
  try {
    const { previewPath } = await renderModuleSvgPreview({
      moduleDir,
      moduleSvgPath,
      scale,
      port: browser.port,
    });
    let blocks = buildSemanticBlocks(hints);
    blocks = await refineTextRegionsFromSvgRender({ blocks, previewPath, scale, port: browser.port });
    blocks = await attachSvgColors({ blocks, moduleSvgPath, scale, port: browser.port });

    const payload: ModuleTextBlocksFile = {
      blockCount: blocks.length,
      blocks,
      coordinateSpace: "local",
      generatedAt: new Date().toISOString(),
      generatedBy: "semantic-text-extract",
      moduleId,
      previewPath,
      region,
    };
    return payload;
  } finally {
    await browser.close();
  }
};

export type { ModuleTextBlocksFile };
export { createModuleTextBlocks };
