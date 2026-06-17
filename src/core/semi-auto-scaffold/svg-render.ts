import path from "node:path";
import { pathToFileURL } from "node:url";

import { capturePage, launchEdge } from "../cdp.js";
import { resolveSvgDesign, writeTextFile } from "../utils.js";

const createSvgRenderWrapper = ({
  height,
  svgUrlPath,
  width,
}: {
  height: number;
  svgUrlPath: string;
  width: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      img {
        display: block;
        width: ${width}px;
        height: ${height}px;
      }
    </style>
  </head>
  <body>
    <img src="${svgUrlPath}" alt="" />
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

const renderSvgToPng = async ({
  artifactDir,
  design,
}: {
  artifactDir: string;
  design: Awaited<ReturnType<typeof resolveSvgDesign>>;
}) => {
  const wrapperPath = path.join(artifactDir, "generate-svg-source.html");
  const svgPngPath = path.join(artifactDir, "svg.png");

  await writeTextFile(
    wrapperPath,
    createSvgRenderWrapper({
      height: design.height,
      svgUrlPath: pathToFileURL(design.svgPath).href,
      width: design.width,
    }),
  );

  const browser = await launchEdge();

  try {
    await capturePage({
      deviceScaleFactor: design.scale,
      outputPath: svgPngPath,
      port: browser.port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });
  } finally {
    await browser.close();
  }

  return svgPngPath;
};

export { renderSvgToPng };
