import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { capturePage, launchEdge } from "../cdp.js";
import { renderSvgToPng } from "../semi-auto-scaffold/svg-render.js";
import { writeTextFile, type resolveSvgDesign } from "../utils.js";
import type { CodexPlannerPreviewImage } from "./types.js";

const PLANNER_TILE_MIN_SPLIT_HEIGHT = 3500;
const PLANNER_TILE_MAX_HEIGHT = 2200;
const PLANNER_TILE_OVERLAP = 120;

type ResolvedSvgDesign = Awaited<ReturnType<typeof resolveSvgDesign>>;

const shouldUseTiledPlannerImages = (height: number) =>
  height > PLANNER_TILE_MIN_SPLIT_HEIGHT;

const createSvgImageWrapper = ({
  bodyHeight,
  bodyWidth,
  imageHeight,
  imageWidth,
  offsetY = 0,
  svgPath,
}: {
  bodyHeight: number;
  bodyWidth: number;
  imageHeight: number;
  imageWidth: number;
  offsetY?: number;
  svgPath: string;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${bodyWidth}, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        width: ${bodyWidth}px;
        height: ${bodyHeight}px;
        overflow: hidden;
        background: #000;
      }

      img {
        display: block;
        width: ${imageWidth}px;
        height: ${imageHeight}px;
        transform: translateY(-${offsetY}px);
      }
    </style>
  </head>
  <body>
    <img src="${pathToFileURL(svgPath).href}" alt="" />
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => {
          window.__RENDER_READY__ = true
        }, 200)
      })
    </script>
  </body>
</html>
`;

const createTileRanges = (height: number) => {
  const ranges: Array<{ height: number; y: number }> = [];
  const step = Math.max(1, PLANNER_TILE_MAX_HEIGHT - PLANNER_TILE_OVERLAP);
  for (let y = 0; y < height; y += step) {
    const bottom = Math.min(height, y + PLANNER_TILE_MAX_HEIGHT);
    ranges.push({ height: bottom - y, y });
    if (bottom >= height) break;
  }
  return ranges;
};

const renderWrapper = async ({
  artifactDir,
  outputPath,
  wrapperName,
  wrapperSource,
  viewportHeight,
  viewportWidth,
}: {
  artifactDir: string;
  outputPath: string;
  wrapperName: string;
  wrapperSource: string;
  viewportHeight: number;
  viewportWidth: number;
}) => {
  const wrapperPath = path.join(artifactDir, wrapperName);
  await writeTextFile(wrapperPath, wrapperSource);
  const browser = await launchEdge();
  try {
    await capturePage({
      outputPath,
      port: browser.port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight,
      viewportWidth,
    });
  } finally {
    await browser.close();
  }
};

const renderCodexPlannerPreviewImages = async ({
  artifactDir,
  design,
}: {
  artifactDir: string;
  design: ResolvedSvgDesign;
}): Promise<CodexPlannerPreviewImage[]> => {
  if (!shouldUseTiledPlannerImages(design.height)) {
    const imagePath = path.join(artifactDir, "svg.png");
    if (!existsSync(imagePath)) {
      await renderSvgToPng({ artifactDir, design });
    }
    return [
      {
        fullHeight: design.height,
        height: design.height,
        imagePath,
        kind: "overview",
        label: "full",
        offsetY: 0,
        scale: 1,
        width: design.width,
      },
    ];
  }

  const images: CodexPlannerPreviewImage[] = [];
  const ranges = createTileRanges(design.height);
  for (const [index, range] of ranges.entries()) {
    const tilePath = path.join(artifactDir, `planner-tile-${index + 1}.png`);
    await renderWrapper({
      artifactDir,
      outputPath: tilePath,
      viewportHeight: range.height,
      viewportWidth: design.width,
      wrapperName: `planner-tile-${index + 1}.html`,
      wrapperSource: createSvgImageWrapper({
        bodyHeight: range.height,
        bodyWidth: design.width,
        imageHeight: design.height,
        imageWidth: design.width,
        offsetY: range.y,
        svgPath: design.svgPath,
      }),
    });
    images.push({
      fullHeight: design.height,
      height: range.height,
      imagePath: tilePath,
      kind: "tile",
      label: `tile-${index + 1}`,
      offsetY: range.y,
      scale: 1,
      width: design.width,
    });
  }

  return images;
};

export { renderCodexPlannerPreviewImages };
