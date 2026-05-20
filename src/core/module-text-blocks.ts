import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { capturePage, launchEdge } from "./cdp.js";
import { runVisionLlm } from "../pipeline/llm-client.js";
import type { Box, Region } from "./utils.js";
import { writeJsonFile, writeTextFile } from "./utils.js";

type ModuleTextBlock = {
  bboxIncludesIcon?: boolean;
  color?: string;
  confidence?: number;
  id: string;
  kind?: string;
  notes?: string;
  region: Box;
  source?: "vision" | "ocr-fallback";
  sourceOcrText?: string;
  text: string;
  textRegion?: Box;
};

type ModuleTextBlocksFile = {
  blockCount: number;
  blocks: ModuleTextBlock[];
  coordinateSpace: "local";
  generatedAt: string;
  generatedBy: "vision-text-extract" | "ocr-fallback";
  moduleId: string;
  previewPath?: string;
  region: Region;
};

type OcrHint = {
  bbox?: Box;
  color?: string;
  confidence?: number;
  id?: string;
  role?: string;
  text?: string;
};

const readSvgOpenAttrs = async (svgPath: string) => {
  const svg = await readFile(svgPath, "utf8");
  const match = svg.match(/<svg\b([^>]*)>/i);
  if (!match?.[1]) throw new Error(`Unable to locate <svg> root: ${svgPath}`);
  return match[1];
};

const readSvgTextPaintCandidates = async (svgPath: string): Promise<Array<{
  box?: Box;
  color: string;
}>> => {
  const svg = await readFile(svgPath, "utf8");
  return [...svg.matchAll(/<(?:path|text|tspan|g)\b[^>]*>/gi)].flatMap((match) => {
    const tag = match[0];
    const fill = readSvgAttr(tag, "fill")?.trim();
    if (!fill || fill === "none" || /^url\(/i.test(fill)) return [];
    const d = readSvgAttr(tag, "d");
    const numbers = d
      ? [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((item) => Number(item[0]))
      : [];
    const points: Array<{ x: number; y: number }> = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      points.push({ x: numbers[index]!, y: numbers[index + 1]! });
    }
    const xs = points.map((point) => point.x).filter(Number.isFinite);
    const ys = points.map((point) => point.y).filter(Number.isFinite);
    const box =
      xs.length && ys.length
        ? {
            height: Math.max(...ys) - Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            x: Math.min(...xs),
            y: Math.min(...ys),
          }
        : undefined;
    return [{ box, color: fill }];
  });
};

const readSvgAttr = (attrs: string, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(['"])(.*?)\\1`, "i"),
  );
  return match?.[2];
};

const parseNumber = (value?: string) => {
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseSvgSize = async (svgPath: string, scale = 1) => {
  const attrs = await readSvgOpenAttrs(svgPath);
  const width = parseNumber(readSvgAttr(attrs, "width"));
  const height = parseNumber(readSvgAttr(attrs, "height"));
  if (width && height) {
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  }
  const viewBox = readSvgAttr(attrs, "viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (viewBox && viewBox.length >= 4 && viewBox[2] && viewBox[3]) {
    return {
      width: Math.round(viewBox[2] * scale),
      height: Math.round(viewBox[3] * scale),
    };
  }
  throw new Error(`Unable to infer SVG size: ${svgPath}`);
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
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      img { display: block; width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>
    <img src="${pathToFileURL(svgPath).href}" alt="" />
    <script>
      window.addEventListener('load', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__RENDER_READY__ = true
        }))
      })
    </script>
  </body>
</html>`;

const renderModuleSvgPreview = async ({
  moduleDir,
  moduleSvgPath,
  scale,
}: {
  moduleDir: string;
  moduleSvgPath: string;
  scale?: number;
}) => {
  const { height, width } = await parseSvgSize(moduleSvgPath, scale);
  const wrapperPath = path.join(moduleDir, "module-text-source.html");
  const previewPath = path.join(moduleDir, "module-text-source.png");
  await writeTextFile(
    wrapperPath,
    createSvgImageWrapper({ height, svgPath: moduleSvgPath, width }),
  );
  const browser = await launchEdge();
  try {
    await capturePage({
      outputPath: previewPath,
      port: browser.port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: height,
      viewportWidth: width,
    });
  } finally {
    await browser.close();
  }
  return { height, previewPath, width };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const readColor = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const areaOf = (box: Box) => Math.max(0, box.width) * Math.max(0, box.height);

const intersectionArea = (left: Box, right: Box) => {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

const attachSvgColors = async ({
  blocks,
  moduleSvgPath,
}: {
  blocks: ModuleTextBlock[];
  moduleSvgPath: string;
}) => {
  const candidates = await readSvgTextPaintCandidates(moduleSvgPath).catch(() => []);
  if (!candidates.length) return blocks;
  const globalColor =
    candidates.length === 1 || candidates.every((candidate) => candidate.color === candidates[0]?.color)
      ? candidates[0]?.color
      : undefined;
  return blocks.map((block) => {
    const region = block.textRegion ?? block.region;
    const matched = candidates
      .flatMap((candidate) => {
        if (!candidate.box) return [];
        const overlap = intersectionArea(region, candidate.box);
        const ratio = overlap / Math.max(1, Math.min(areaOf(region), areaOf(candidate.box)));
        return [{ color: candidate.color, ratio }];
      })
      .filter((candidate) => candidate.ratio >= 0.2)
      .sort((left, right) => right.ratio - left.ratio)[0];
    const color = matched?.color ?? globalColor;
    return color ? { ...block, color } : block;
  });
};

const stripJsonMarkdown = (raw: string) => {
  const content = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start >= 0 && end > start ? content.slice(start, end + 1) : content;
};

const normalizeVisionBlocks = ({
  fallbackOcrHints,
  raw,
}: {
  fallbackOcrHints: OcrHint[];
  raw: string;
}) => {
  const parsed = JSON.parse(stripJsonMarkdown(raw)) as unknown;
  const blocks = isRecord(parsed) && Array.isArray(parsed["blocks"])
    ? parsed["blocks"]
    : [];
  return blocks.flatMap((block, index): ModuleTextBlock[] => {
    if (!isRecord(block)) return [];
    const text = typeof block["text"] === "string" ? block["text"].trim() : "";
    const region = readBox(block["textRegion"]) ?? readBox(block["region"]);
    if (!text || !region) return [];
    const sourceOcrId =
      typeof block["sourceOcrId"] === "string" ? block["sourceOcrId"] : undefined;
    const fallback = sourceOcrId
      ? fallbackOcrHints.find((hint) => hint.id === sourceOcrId)
      : fallbackOcrHints[index];
    return [
      {
        bboxIncludesIcon: Boolean(block["bboxIncludesIcon"]),
        color:
          readColor(block["color"]) ??
          readColor(block["textColor"]) ??
          readColor(fallback?.color),
        confidence: getNumber(block["confidence"]),
        id:
          typeof block["id"] === "string" && block["id"].trim()
            ? block["id"].trim()
            : fallback?.id ?? `vision-text-${index + 1}`,
        kind: typeof block["kind"] === "string" ? block["kind"] : fallback?.role,
        notes: typeof block["notes"] === "string" ? block["notes"] : undefined,
        region: readBox(block["region"]) ?? region,
        source: "vision",
        sourceOcrText: fallback?.text,
        text,
        textRegion: readBox(block["textRegion"]) ?? region,
      },
    ];
  });
};

const fallbackOcrBlocks = (ocrHints: OcrHint[]) =>
  ocrHints.flatMap((hint, index): ModuleTextBlock[] => {
    const text = typeof hint.text === "string" ? hint.text.trim() : "";
    if (!text || !hint.bbox) return [];
    return [
      {
        color: hint.color,
        confidence: typeof hint.confidence === "number" ? hint.confidence : undefined,
        id: hint.id ?? `ocr-fallback-${index + 1}`,
        kind: hint.role,
        region: hint.bbox,
        source: "ocr-fallback",
        sourceOcrText: text,
        text,
        textRegion: hint.bbox,
      },
    ];
  });

const buildPrompt = ({ ocrHints }: { ocrHints: OcrHint[] }) =>
  `你是设计稿文本真值提取器。请只根据图片视觉内容确认模块里的可读 UI 文本，不要根据 OCR 盲猜。

要求：
- 输出严格 JSON，不要 markdown。
- OCR hints 只是粗略定位和参考，可能经常错；如果图片里看起来不是 OCR 文本，以图片为准。
- 如果一个 OCR 框包含 icon + 文本，请 text 只写真实文字，bboxIncludesIcon=true，并给出只包住文字的 textRegion。
- 如果多个 OCR hints 分别对应同一行里的相邻文字块，请尽量按 OCR hint 拆成多个 blocks 并沿用各自 id；只有视觉上不可分或 OCR 分块明显错误时才合并。
- 如果合并多个 OCR hints，请在 notes 里说明，并优先使用第一个相关 OCR id。
- region/textRegion 坐标使用图片本地像素坐标，原点在左上角。
- 不要输出装饰图标、logo 形状、头像、纯背景、无法辨认的乱码。
- 对导航、按钮、标题、输入框 placeholder、标签等 UI 文案要尽量完整。
- 如果能从图片中明确判断文字颜色，请输出 color，格式优先使用 #RRGGBB；不确定可省略。
- confidence 取 0 到 1。

OCR hints:
${JSON.stringify(
  ocrHints.map((hint) => ({
    bbox: hint.bbox,
    color: hint.color,
    confidence: hint.confidence,
    id: hint.id,
    role: hint.role,
    text: hint.text,
  })),
  null,
  2,
)}

输出格式：
{
  "blocks": [
    {
      "id": "沿用最接近的 OCR id，或 text-1",
      "sourceOcrId": "可选 OCR id",
      "text": "确认后的真实文字",
      "region": { "x": 0, "y": 0, "width": 100, "height": 30 },
      "textRegion": { "x": 20, "y": 0, "width": 80, "height": 30 },
      "color": "#18191C",
      "bboxIncludesIcon": true,
      "kind": "nav-label|title|button|placeholder|label|paragraph|other",
      "confidence": 0.95,
      "notes": "可选"
    }
  ]
}`;

const createModuleTextBlocks = async ({
  moduleDir,
  moduleId,
  moduleOcrBlocksPath,
  moduleSvgPath,
  outputPath = path.join(moduleDir, "module-text-blocks.json"),
  region,
  scale,
}: {
  moduleDir: string;
  moduleId: string;
  moduleOcrBlocksPath: string;
  moduleSvgPath: string;
  outputPath?: string;
  region: Region;
  scale?: number;
}): Promise<ModuleTextBlocksFile> => {
  const rawOcr = existsSync(moduleOcrBlocksPath)
    ? (JSON.parse(await readFile(moduleOcrBlocksPath, "utf8")) as unknown)
    : {};
  const ocrHints = (
    isRecord(rawOcr) && Array.isArray(rawOcr["blocks"]) ? rawOcr["blocks"] : []
  ).flatMap((block): OcrHint[] => {
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
        role: typeof block["role"] === "string" ? block["role"] : undefined,
        text: typeof block["text"] === "string" ? block["text"] : undefined,
      },
    ];
  });
  const { previewPath } = await renderModuleSvgPreview({
    moduleDir,
    moduleSvgPath,
    scale,
  });
  let blocks: ModuleTextBlock[] = [];
  let generatedBy: ModuleTextBlocksFile["generatedBy"] = "vision-text-extract";

  try {
    const raw = await runVisionLlm({
      imagePath: previewPath,
      prompt: buildPrompt({ ocrHints }),
    });
    blocks = normalizeVisionBlocks({ fallbackOcrHints: ocrHints, raw });
  } catch {
    blocks = fallbackOcrBlocks(ocrHints);
    generatedBy = "ocr-fallback";
  }
  blocks = await attachSvgColors({ blocks, moduleSvgPath });

  const payload: ModuleTextBlocksFile = {
    blockCount: blocks.length,
    blocks,
    coordinateSpace: "local",
    generatedAt: new Date().toISOString(),
    generatedBy,
    moduleId,
    previewPath,
    region,
  };
  await writeJsonFile(outputPath, payload);
  return payload;
};

export type { ModuleTextBlock, ModuleTextBlocksFile };
export { createModuleTextBlocks };
