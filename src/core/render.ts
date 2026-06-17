import path from "node:path";
import { readFile } from "node:fs/promises";

import { capturePage, evaluatePage, launchEdge } from "./cdp.js";
import { startStaticServer } from "./static-server.js";
import {
  assertFile,
  type ResolvedSvgDesign,
  resolveArtifactDir,
  resolveSvgDesign,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
} from "./utils.js";

type RenderResult = {
  artifactDir: string;
  renderImageErrors: HtmlImageError[];
  renderPngPath: string;
  renderWrapperPath: string;
  sourceImageErrors: HtmlImageError[];
  sourceBasis?: string;
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

type RenderDesign = ResolvedSvgDesign & {
  renderEntryPath: string;
};

const SVG_WRAPPER_NAME = "render-svg.html";
const RENDER_WRAPPER_NAME = "render-output.html";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripScriptBlocksForIntegrity = (html: string) =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script></script>");

const collectHtmlIntegrityIssues = (html: string, design: RenderDesign) => {
  const issues: string[] = [];
  const lowerHtml = stripScriptBlocksForIntegrity(html).toLowerCase();
  const svgBaseName = path.basename(design.svgPath).toLowerCase();
  const escapedSvgBaseName = escapeRegExp(svgBaseName);

  const pushIfMatch = (pattern: RegExp, message: string) => {
    if (pattern.test(lowerHtml)) issues.push(message);
  };

  pushIfMatch(
    /<iframe\b[^>]+src\s*=\s*["'][^"']*\.svg(?:[?#][^"']*)?["']/i,
    "Rendered output uses <iframe> to load an SVG asset.",
  );
  pushIfMatch(
    /data:image\//i,
    "Rendered output embeds image content via a data URL.",
  );
  pushIfMatch(
    /(?:<img\b[^>]+src\s*=\s*["'](?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/)/i,
    "Rendered output references a remote image asset.",
  );
  pushIfMatch(/<svg\b/i, "Rendered output contains inline <svg> markup.");
  pushIfMatch(
    new RegExp(escapedSvgBaseName, "i"),
    `Rendered output references the source SVG file name (${svgBaseName}).`,
  );

  return issues;
};

const checkHtmlIntegrity = async (design: RenderDesign) => {
  const html = await readFile(design.renderEntryPath, "utf8");
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
  renderEntryUrlPath,
  imageErrorsGlobal = "__RENDER_IMAGE_ERRORS__",
  height,
  width,
}: {
  renderEntryUrlPath: string;
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
        background: transparent;
      }

      iframe {
        display: block;
        width: ${width}px;
        height: ${height}px;
        border: 0;
        background: transparent;
      }
    </style>
  </head>
  <body>
    <iframe id="source" src="${renderEntryUrlPath}"></iframe>
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
      // Capture runtime errors thrown inside the iframe render entry (e.g.
      // an undeclared sourceData/data reference in a framework bundle that
      // compiled but threw at mount time). Used by the post-merge render health
      // check to surface blank-mount failures with a concrete reason.
      window.__RENDER_RUNTIME_ERRORS__ = []
      source.addEventListener('load', () => {
        try {
          const win = source.contentWindow
          if (win) {
            win.addEventListener('error', (event) => {
              const msg = (event && event.message) || 'unknown error'
              window.__RENDER_RUNTIME_ERRORS__.push(String(msg).slice(0, 300))
            })
            win.addEventListener('unhandledrejection', (event) => {
              const reason = event && event.reason
              const msg = reason instanceof Error ? reason.message : String(reason)
              window.__RENDER_RUNTIME_ERRORS__.push('unhandledrejection: ' + String(msg).slice(0, 300))
            })
          }
        } catch {}
      })
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
    renderEntryPath: string;
    scale?: number;
    sourceBasis?: string;
    sourceHtmlPath?: string;
  },
): Promise<RenderResult> => {
  if (!options?.renderEntryPath) {
    throw new Error("renderDesignTargets requires renderEntryPath");
  }
  const resolvedDesign = await resolveSvgDesign(inputPath, {
    scale: options.scale,
  });
  const design: RenderDesign = {
    ...resolvedDesign,
    renderEntryPath: toAbsolutePath(options.renderEntryPath),
  };
  await assertFile(design.renderEntryPath, "Render entry");
  const artifactDir = await resolveArtifactDir(
    design.svgPath,
    customArtifactDir,
  );
  const renderIntegrityIssues = await checkHtmlIntegrity(design);

  const svgWrapperPath = path.join(artifactDir, SVG_WRAPPER_NAME);
  const renderWrapperPath = path.join(artifactDir, RENDER_WRAPPER_NAME);
  const svgPngPath = path.join(artifactDir, "svg.png");
  const renderPngPath = path.join(artifactDir, "render.png");
  const sourceRenderMode = options?.sourceHtmlPath ? "html" : "svg-image";
  const sourceBasis = options?.sourceBasis ?? sourceRenderMode;

  await writeTextFile(
    svgWrapperPath,
    options?.sourceHtmlPath
      ? createHtmlWrapper({
          renderEntryUrlPath: toUrlPath(options.sourceHtmlPath),
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
    renderWrapperPath,
    createHtmlWrapper({
      renderEntryUrlPath: toUrlPath(design.renderEntryPath),
      height: design.height,
      width: design.width,
    }),
  );

  const server = await startStaticServer();
  const browser = await launchEdge();
  let renderImageErrors: HtmlImageError[] = [];
  let sourceImageErrors: HtmlImageError[] = [];

  try {
    await capturePage({
      deviceScaleFactor: design.scale,
      opaqueBackground: true,
      outputPath: svgPngPath,
      port: browser.port,
      url: `${server.origin}${toUrlPath(svgWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    await capturePage({
      deviceScaleFactor: design.scale,
      opaqueBackground: true,
      outputPath: renderPngPath,
      port: browser.port,
      url: `${server.origin}${toUrlPath(renderWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    sourceImageErrors = await evaluatePage<HtmlImageError[]>({
      deviceScaleFactor: design.scale,
      expression:
        sourceRenderMode === "html"
          ? "window.__RENDER_SOURCE_IMAGE_ERRORS__ ?? []"
          : `window.__RENDER_SVG_IMAGE_ERROR__ ? [{ alt: "", currentSrc: ${JSON.stringify(toUrlPath(design.svgPath))}, naturalHeight: 0, naturalWidth: 0, src: ${JSON.stringify(toUrlPath(design.svgPath))} }] : []`,
      port: browser.port,
      url: `${server.origin}${toUrlPath(svgWrapperPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    renderImageErrors = await evaluatePage<HtmlImageError[]>({
      deviceScaleFactor: design.scale,
      expression: "window.__RENDER_IMAGE_ERRORS__ ?? []",
      port: browser.port,
      url: `${server.origin}${toUrlPath(renderWrapperPath)}`,
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
    renderImageErrors,
    renderImageIntegrityPassed: renderImageErrors.length === 0,
    renderIntegrityIssues,
    renderIntegrityPassed: renderIntegrityIssues.length === 0,
    renderEntryPath: design.renderEntryPath,
    renderPngPath,
    sourceHtmlPath: options?.sourceHtmlPath,
    sourceBasis,
    sourceImageErrors,
    sourceImageIntegrityPassed: sourceImageErrors.length === 0,
    sourceRenderMode,
    svgPngPath,
    width: design.width,
  });

  return {
    artifactDir,
    renderImageErrors,
    renderPngPath,
    renderWrapperPath,
    sourceBasis,
    sourceImageErrors,
    sourceRenderMode,
    svgPngPath,
    svgWrapperPath,
  };
};

export { renderDesignTargets };
