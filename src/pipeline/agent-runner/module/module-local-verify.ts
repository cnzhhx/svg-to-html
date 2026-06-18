import path from "node:path";
import { readFile } from "node:fs/promises";

import { MODULE_DIFF_RATIO_THRESHOLD } from "../../../config/index.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import type { Region } from "../../../core/geometry.js";
import { toUrlPath } from "../../../core/paths.js";
import { writeTextFile } from "../../../core/file-io.js";
import { rewriteModuleLocalAssetReferences } from "../../module-merge/html-render.js";
import type { ModulePlan } from "../../module-merge/types.js";
import { formatRegionStyle, resolveConfiguredPath } from "../../module-merge/utils.js";
import { readModuleAllowedAssets } from "./module-semantic.js";
import { verifyDesign } from "../../verify.js";

type ModuleLocalVerifyInput = {
  module: Pick<SvgVerticalModule, "id" | "region">;
  moduleDir: string;
  modulePlan?: Pick<ModulePlan, "design" | "outputFormat" | "sharedLayers">;
  modulePlanPath?: string;
  moduleSvgPath: string;
  round: number;
  scale?: number;
  scaffoldHtmlPath: string;
  onProgress?: (message: string) => void;
};

type ModuleLocalVerifyResult = {
  artifactDir: string;
  diffPixels?: number;
  diffRatio: number;
  moduleId: string;
  passed: boolean;
  previewHtmlPath: string;
  renderPngPath: string;
  svgPngPath: string;
  sourceBasis: ModuleLocalVerifySourceBasis;
  sourceRenderMode?: "svg-image" | "html";
  targetHtmlPath?: string;
  targetSvgPath: string;
};

type ModuleLocalVerifySourceBasis =
  | "composite-html"
  | "module-svg"
  | "original-svg-region";

type ModuleLocalVerifySource = {
  originalSvgPath?: string;
  sourceBasis: ModuleLocalVerifySourceBasis;
  sourceHtmlPath?: string;
  sourceSvgPath: string;
  targetHtmlPath?: string;
  targetSvgPath: string;
};

type LocalSharedLayer = {
  htmlRef: string;
  id: string;
  kind: "shared-underlay";
  region: Region;
};

const extractScaffoldStyleBlocks = (html: string) =>
  [
    ...html.matchAll(
      /<style\b(?![^>]*data-module-merge-generated)[^>]*>[\s\S]*?<\/style>/gi,
    ),
  ]
    .map((match) => match[0])
    .join("\n");

const buildModuleLocalVerifyTarget = ({
  moduleSvgPath,
}: {
  moduleSvgPath: string;
}) => {
  return {
    sourceSvgPath: moduleSvgPath,
    targetSvgPath: moduleSvgPath,
  };
};

const buildModuleLocalVerifySource = ({
  moduleSvgPath,
  sourceHtmlPath,
}: {
  moduleSvgPath: string;
  sourceHtmlPath?: string;
}): ModuleLocalVerifySource => {
  const target = buildModuleLocalVerifyTarget({
    moduleSvgPath,
  });
  return {
    ...target,
    sourceBasis: sourceHtmlPath ? "composite-html" : "module-svg",
    sourceHtmlPath,
  };
};

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const toSafeClassName = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "shared-layer";

const intersects = (a: Region, b: Region) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

const buildLocalSharedLayers = ({
  module,
  modulePlan,
  modulePlanPath,
}: {
  module: Pick<SvgVerticalModule, "region">;
  modulePlan?: Pick<ModulePlan, "sharedLayers">;
  modulePlanPath?: string;
}): LocalSharedLayer[] => {
  if (!modulePlanPath || !Array.isArray(modulePlan?.sharedLayers)) {
    return [];
  }

  const planDir = path.dirname(modulePlanPath);
  return modulePlan.sharedLayers.flatMap((layer, index) => {
    if (
      layer.kind !== "shared-underlay" ||
      !layer.region ||
      !intersects(layer.region, module.region)
    ) {
      return [];
    }

    const sourceRef =
      typeof layer.svgPath === "string"
        ? layer.svgPath
        : typeof layer.relativePath === "string"
          ? layer.relativePath
          : undefined;
    if (!sourceRef) return [];

    const assetPath = resolveConfiguredPath(sourceRef, planDir);
    return [
      {
        htmlRef: toUrlPath(assetPath),
        id: layer.id || `shared-underlay-${index + 1}`,
        kind: "shared-underlay" as const,
        region: {
          ...layer.region,
          x: layer.region.x - module.region.x,
          y: layer.region.y - module.region.y,
        },
      },
    ];
  });
};

const renderSharedLayerSections = (sharedLayers: LocalSharedLayer[]) =>
  sharedLayers
    .map((layer) =>
      [
        `<div class="shared-design-layer ${escapeHtmlAttribute(toSafeClassName(layer.id))}" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style="${formatRegionStyle(layer.region)}">`,
        `        <img class="shared-design-layer__asset" src="${escapeHtmlAttribute(layer.htmlRef)}" alt="" aria-hidden="true" />`,
        "      </div>",
      ].join("\n"),
    )
    .join("\n      ");

const buildModulePreviewHtml = ({
  height,
  moduleCss,
  moduleId,
  previewFragmentHtml,
  scaffoldStyles,
  sharedLayerSections,
  width,
}: {
  height: number;
  moduleCss: string;
  moduleId: string;
  previewFragmentHtml: string;
  scaffoldStyles: string;
  sharedLayerSections: string;
  width: number;
}) => {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1" />
    ${scaffoldStyles}
    <style data-module-local-verify>
      html,
      body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
      }

      .design-page {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }

      .shared-design-layer {
        position: absolute;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
      }

      .shared-design-layer[data-shared-layer-kind="shared-underlay"] {
        z-index: 0;
      }

      .shared-design-layer__asset {
        display: block;
        width: 100%;
        height: 100%;
      }

      .design-module {
        position: absolute;
        left: 0;
        top: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
        z-index: 10;
      }

      .design-module,
      .design-module * {
        box-sizing: border-box;
      }

${moduleCss
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    </style>
  </head>
  <body>
    <main class="design-page">
${sharedLayerSections
  .split("\n")
  .filter(Boolean)
  .map((line) => `      ${line}`)
  .join("\n")}
      <section class="design-module ${moduleId}" data-module-id="${moduleId}">
${previewFragmentHtml
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
      </section>
    </main>
  </body>
</html>
`;
};

const buildModuleSourceHtml = ({
  height,
  moduleId,
  moduleSvgPath,
  sharedLayerSections,
  width,
}: {
  height: number;
  moduleId: string;
  moduleSvgPath: string;
  sharedLayerSections: string;
  width: number;
}) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1" />
    <style>
      html,
      body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      .design-page {
        position: relative;
        width: ${width}px;
        height: ${height}px;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }

      .shared-design-layer {
        position: absolute;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
      }

      .shared-design-layer[data-shared-layer-kind="shared-underlay"] {
        z-index: 0;
      }

      .shared-design-layer__asset,
      .design-module__asset {
        display: block;
        width: 100%;
        height: 100%;
      }

      .design-module {
        position: absolute;
        left: 0;
        top: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
        z-index: 10;
      }

      .design-module,
      .design-module * {
        box-sizing: border-box;
      }
    </style>
  </head>
  <body>
    <main class="design-page">
${sharedLayerSections
  .split("\n")
  .filter(Boolean)
  .map((line) => `      ${line}`)
  .join("\n")}
      <section class="design-module ${moduleId}" data-module-id="${moduleId}">
        <img class="design-module__asset" src="${escapeHtmlAttribute(toUrlPath(moduleSvgPath))}" alt="" aria-hidden="true" />
      </section>
    </main>
  </body>
</html>
`;

const getModulePreviewHtmlPath = (moduleDir: string, round: number) =>
  path.join(moduleDir, `module-preview-round-${round}.html`);

const getModuleSourceHtmlPath = (moduleDir: string, round: number) =>
  path.join(moduleDir, `module-source-round-${round}.html`);

const getModuleVerifyArtifactDir = (moduleDir: string, round: number) =>
  path.join(moduleDir, "verify", `round-${round}`);

const verifyModuleLocal = async ({
  module,
  moduleDir,
  modulePlan,
  modulePlanPath,
  moduleSvgPath,
  onProgress,
  round,
  scale,
  scaffoldHtmlPath,
}: ModuleLocalVerifyInput): Promise<ModuleLocalVerifyResult> => {
  const [previewFragmentHtml, moduleCss, scaffoldHtml, allowedAssets] =
    await Promise.all([
      readFile(path.join(moduleDir, "preview.fragment.html"), "utf8"),
      readFile(path.join(moduleDir, "module.css"), "utf8"),
      readFile(scaffoldHtmlPath, "utf8"),
      readModuleAllowedAssets(moduleDir),
    ]);
  const previewHtmlPath = getModulePreviewHtmlPath(moduleDir, round);
  const artifactDir = getModuleVerifyArtifactDir(moduleDir, round);
  const sharedLayers = buildLocalSharedLayers({
    module,
    modulePlan,
    modulePlanPath,
  });
  const sharedLayerSections = renderSharedLayerSections(sharedLayers);
  onProgress?.(
    sharedLayers.length
      ? "Local verify compares module output with shared underlay context."
      : "Local verify has no shared underlay context; falling back to module SVG.",
  );
  const resolvedPreviewFragmentHtml = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: previewFragmentHtml,
    moduleDir,
    renderEntryPath: previewHtmlPath,
  });
  const resolvedModuleCss = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: moduleCss,
    moduleDir,
    renderEntryPath: previewHtmlPath,
  });
  await writeTextFile(
    previewHtmlPath,
    buildModulePreviewHtml({
      height: module.region.height,
      moduleCss: resolvedModuleCss,
      moduleId: module.id,
      previewFragmentHtml: resolvedPreviewFragmentHtml,
      scaffoldStyles: extractScaffoldStyleBlocks(scaffoldHtml),
      sharedLayerSections,
      width: module.region.width,
    }),
  );
  const sourceHtmlPath = sharedLayers.length
    ? getModuleSourceHtmlPath(moduleDir, round)
    : undefined;
  if (sourceHtmlPath) {
    await writeTextFile(
      sourceHtmlPath,
      buildModuleSourceHtml({
        height: module.region.height,
        moduleId: module.id,
        moduleSvgPath,
        sharedLayerSections,
        width: module.region.width,
      }),
    );
  }
  const target = await buildModuleLocalVerifySource({
    moduleSvgPath,
    sourceHtmlPath,
  });
  onProgress?.(`Local verify source basis: ${target.sourceBasis}`);

  const result = await verifyDesign(
    target.sourceSvgPath,
    onProgress,
    artifactDir,
    {
      mode: "fast",
      renderEntryPath: previewHtmlPath,
      scale,
      sourceBasis: target.sourceBasis,
      sourceHtmlPath: target.sourceHtmlPath,
    },
  );

  return {
    artifactDir: result.artifactDir,
    diffRatio: result.diffRatio,
    moduleId: module.id,
    passed: result.diffRatio <= MODULE_DIFF_RATIO_THRESHOLD,
    previewHtmlPath,
    renderPngPath: result.renderPngPath,
    sourceBasis: target.sourceBasis,
    sourceRenderMode: result.sourceRenderMode,
    svgPngPath: result.svgPngPath,
    targetHtmlPath: target.targetHtmlPath,
    targetSvgPath: target.targetSvgPath,
  };
};

export { verifyModuleLocal };
