import path from "node:path";
import { readFile } from "node:fs/promises";

import { capturePage, evaluatePage, launchEdge } from "./cdp.js";
import startStaticServer from "./static-server.js";
import {
  type DesignPair,
  resolveArtifactDir,
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
} from "./utils.js";

type RenderResult = {
  artifactDir: string;
  htmlImageErrors: HtmlImageError[];
  htmlPngPath: string;
  htmlWrapperPath: string;
  sourceImageErrors: HtmlImageError[];
  sourceRenderMode: "svg-image" | "html";
  svgPngPath: string;
  svgWrapperPath: string;
};

type HtmlImageError = {
  alt: string;
  currentSrc: string;
  naturalHeight: number;
  naturalWidth: number;
  src: string;
};

const SVG_WRAPPER_NAME = "render-svg.html";
const HTML_WRAPPER_NAME = "render-html.html";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collectHtmlIntegrityIssues = (html: string, design: DesignPair) => {
  const issues: string[] = [];
  const lowerHtml = html.toLowerCase();
  const svgBaseName = path.basename(design.svgPath).toLowerCase();
  const escapedSvgBaseName = escapeRegExp(svgBaseName);

  const pushIfMatch = (pattern: RegExp, message: string) => {
    if (pattern.test(lowerHtml)) issues.push(message);
  };

  pushIfMatch(
    /<iframe\b[^>]+src\s*=\s*["'][^"']*\.svg(?:[?#][^"']*)?["']/i,
    "HTML uses <iframe> to load an SVG asset.",
  );
  pushIfMatch(/data:image\//i, "HTML embeds image content via a data URL.");
  pushIfMatch(
    /(?:<img\b[^>]+src\s*=\s*["'](?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/)/i,
    "HTML references a remote image asset.",
  );
  pushIfMatch(/<svg\b/i, "HTML contains inline <svg> markup.");
  pushIfMatch(
    new RegExp(escapedSvgBaseName, "i"),
    `HTML references the source SVG file name (${svgBaseName}).`,
  );

  return issues;
};

const checkHtmlIntegrity = async (design: DesignPair) => {
  const html = await readFile(design.htmlPath, "utf8");
  return collectHtmlIntegrityIssues(html, design);
};

const createSvgWrapper = ({
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
        background: #000;
      }

      img {
        display: block;
        width: ${width}px;
        height: ${height}px;
      }
    </style>
  </head>
  <body>
    <img id="source-svg" src="${svgUrlPath}" alt="" />
    <script>
      window.addEventListener('load', () => {
        const image = document.getElementById('source-svg')
        const waitForSourceImage = () => {
          if (image.complete) return Promise.resolve()
          return new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
          })
        }
        const waitForPaint = () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          })

        ;(async () => {
          await waitForSourceImage()
          window.__RENDER_SVG_IMAGE_ERROR__ =
            image.naturalWidth <= 0 || image.naturalHeight <= 0
          if (!window.__RENDER_SVG_IMAGE_ERROR__ && image.decode) {
            try {
              await image.decode()
            } catch {}
          }
          await waitForPaint()
          await new Promise((resolve) => setTimeout(resolve, 500))
          window.__RENDER_READY__ = true
        })()
      })
    </script>
  </body>
</html>
`;

const createHtmlWrapper = ({
  designHtmlUrlPath,
  imageErrorsGlobal = "__RENDER_IMAGE_ERRORS__",
  height,
  width,
}: {
  designHtmlUrlPath: string;
  imageErrorsGlobal?: string;
  height: number;
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
        background: #000;
      }

      iframe {
        display: block;
        width: ${width}px;
        height: ${height}px;
        border: 0;
        background: #000;
      }
    </style>
  </head>
  <body>
    <iframe id="source" src="${designHtmlUrlPath}"></iframe>
    <script>
      const waitForImages = async (root) => {
        const errors = []
        const images = [...root.querySelectorAll('img')]
        await Promise.all(images.map((image) => {
          const recordError = () => {
            if (image.naturalWidth > 0 && image.naturalHeight > 0) return
            errors.push({
              alt: image.getAttribute('alt') || '',
              currentSrc: image.currentSrc || '',
              naturalHeight: image.naturalHeight || 0,
              naturalWidth: image.naturalWidth || 0,
              src: image.getAttribute('src') || '',
            })
          }
          if (image.complete) {
            recordError()
            return Promise.resolve()
          }
          return new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', () => {
              recordError()
              resolve()
            }, { once: true })
          })
        }))
        return errors
      }

      const source = document.getElementById('source')
      source.addEventListener('load', async () => {
        const sourceDocument = source.contentDocument
        window.${imageErrorsGlobal} = await waitForImages(sourceDocument)
        if (source.contentWindow?.document?.fonts) {
          try {
            await source.contentWindow.document.fonts.ready
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        window.__RENDER_READY__ = true
      })
    </script>
  </body>
</html>
`;

const renderDesignTargets = async (
  inputPath: string,
  customArtifactDir?: string,
  options?: {
    htmlPath?: string;
    scale?: number;
    sourceHtmlPath?: string;
  },
): Promise<RenderResult> => {
  const resolvedDesign = options?.htmlPath
    ? await resolveSvgDesign(inputPath, { scale: options?.scale })
    : await resolveDesignPair(inputPath, { scale: options?.scale });
  const design = options?.htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(options.htmlPath),
      }
    : resolvedDesign;
  const artifactDir = await resolveArtifactDir(
    design.svgPath,
    customArtifactDir,
  );
  const htmlIntegrityIssues = await checkHtmlIntegrity(design);

  const svgWrapperPath = path.join(artifactDir, SVG_WRAPPER_NAME);
  const htmlWrapperPath = path.join(artifactDir, HTML_WRAPPER_NAME);
  const svgPngPath = path.join(artifactDir, "svg.png");
  const htmlPngPath = path.join(artifactDir, "html.png");
  const sourceRenderMode = options?.sourceHtmlPath ? "html" : "svg-image";

  await writeTextFile(
    svgWrapperPath,
    options?.sourceHtmlPath
      ? createHtmlWrapper({
          designHtmlUrlPath: toUrlPath(options.sourceHtmlPath),
          imageErrorsGlobal: "__RENDER_SOURCE_IMAGE_ERRORS__",
          height: design.height,
          width: design.width,
        })
      : createSvgWrapper({
          height: design.height,
          svgUrlPath: toUrlPath(design.svgPath),
          width: design.width,
        }),
  );

  await writeTextFile(
    htmlWrapperPath,
    createHtmlWrapper({
      designHtmlUrlPath: toUrlPath(design.htmlPath),
      height: design.height,
      width: design.width,
    }),
  );

  const server = await startStaticServer();
  const browser = await launchEdge();
  let htmlImageErrors: HtmlImageError[] = [];
  let sourceImageErrors: HtmlImageError[] = [];

  try {
    await capturePage({
      outputPath: svgPngPath,
      port: browser.port,
      url: `${server.origin}${toUrlPath(svgWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    await capturePage({
      outputPath: htmlPngPath,
      port: browser.port,
      url: `${server.origin}${toUrlPath(htmlWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    sourceImageErrors = await evaluatePage<HtmlImageError[]>({
      expression:
        sourceRenderMode === "html"
          ? "window.__RENDER_SOURCE_IMAGE_ERRORS__ ?? []"
          : `window.__RENDER_SVG_IMAGE_ERROR__ ? [{ alt: "", currentSrc: ${JSON.stringify(toUrlPath(design.svgPath))}, naturalHeight: 0, naturalWidth: 0, src: ${JSON.stringify(toUrlPath(design.svgPath))} }] : []`,
      port: browser.port,
      url: `${server.origin}${toUrlPath(svgWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    htmlImageErrors = await evaluatePage<HtmlImageError[]>({
      expression: "window.__RENDER_IMAGE_ERRORS__ ?? []",
      port: browser.port,
      url: `${server.origin}${toUrlPath(htmlWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });
  } finally {
    await Promise.all([
      Promise.race([
        server.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
      Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
    ]);
  }

  await writeJsonFile(path.join(artifactDir, "render-report.json"), {
    designName: design.designName,
    height: design.height,
    htmlImageErrors,
    htmlImageIntegrityPassed: htmlImageErrors.length === 0,
    htmlIntegrityIssues,
    htmlIntegrityPassed: htmlIntegrityIssues.length === 0,
    htmlPngPath,
    sourceHtmlPath: options?.sourceHtmlPath,
    sourceImageErrors,
    sourceImageIntegrityPassed: sourceImageErrors.length === 0,
    sourceRenderMode,
    svgPngPath,
    width: design.width,
  });

  return {
    artifactDir,
    htmlImageErrors,
    htmlPngPath,
    htmlWrapperPath,
    sourceImageErrors,
    sourceRenderMode,
    svgPngPath,
    svgWrapperPath,
  };
};

export { collectHtmlIntegrityIssues, renderDesignTargets };
