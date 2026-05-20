import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

import { MODULE_DIFF_RATIO_THRESHOLD } from "../../config/runtime.js";
import type { SvgVerticalModule } from "../../core/svg-vertical-modules/types.js";
import { writeTextFile } from "../../core/utils.js";
import { rewriteModuleLocalAssetReferences } from "../module-merge/html-render.js";
import type {
  ModulePlan,
  ModulePlanSharedLayer,
} from "../module-merge/types.js";
import { resolveConfiguredPath } from "../module-merge/utils.js";
import type { ModuleOutputAllowedAsset } from "../module-output-policy.js";
import { verifyDesign } from "../verify.js";

type ModuleLocalVerifyInput = {
  module: Pick<SvgVerticalModule, "id" | "region">;
  moduleDir: string;
  modulePlan?: Pick<ModulePlan, "design" | "sharedLayers">;
  modulePlanPath?: string;
  moduleSvgPath: string;
  round: number;
  scale?: number;
  scaffoldHtmlPath: string;
  onProgress?: (message: string) => void;
};

type ModuleLocalVerifyResult = {
  artifactDir: string;
  diffPngPath: string;
  diffPixels?: number;
  diffRatio: number;
  htmlPath: string;
  htmlPngPath: string;
  moduleId: string;
  passed: boolean;
  svgPngPath: string;
  targetHtmlPath?: string;
  targetSvgPath: string;
  verifyReportPath: string;
};

type ModuleLocalVerifyCacheInput = ModuleLocalVerifyInput;

type FastVerifyReport = {
  diffPixels?: number;
  diffPngPath?: string;
  diffRatio?: number;
  htmlPngPath?: string;
  sourceImageErrors?: unknown[];
  sourceImageIntegrityPassed?: boolean;
  sourceRenderMode?: "svg-image" | "html";
  svgPngPath?: string;
};

type RenderReport = {
  height?: number;
  sourceImageErrors?: unknown[];
  sourceImageIntegrityPassed?: boolean;
  sourceRenderMode?: "svg-image" | "html";
  width?: number;
};

type LocalSharedLayer = {
  htmlRef: string;
  id: string;
  kind: ModulePlanSharedLayer["kind"];
  region: NonNullable<ModulePlanSharedLayer["region"]>;
  svgPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const readAllowedAssets = async (
  moduleDir: string,
): Promise<ModuleOutputAllowedAsset[]> => {
  try {
    const parsed = await readJson<unknown>(
      path.join(moduleDir, "allowed-assets.json"),
    );
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord) as ModuleOutputAllowedAsset[];
    }
    if (isRecord(parsed) && Array.isArray(parsed.assets)) {
      return parsed.assets.filter(isRecord) as ModuleOutputAllowedAsset[];
    }
  } catch {}
  return [];
};

const collectExistingFilePaths = async (
  filePath: string,
): Promise<string[]> => {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) return [filePath];
    if (!fileStat.isDirectory()) return [];
    const entries = await readdir(filePath, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) =>
        collectExistingFilePaths(path.join(filePath, entry.name)),
      ),
    );
    return nested.flat();
  } catch {
    return [];
  }
};

const extractScaffoldStyleBlocks = (html: string) =>
  [
    ...html.matchAll(
      /<style\b(?![^>]*data-module-merge-generated)[^>]*>[\s\S]*?<\/style>/gi,
    ),
  ]
    .map((match) => match[0])
    .join("\n");

const formatNumber = (value: number) => {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/\.?0+$/, "");
};

const formatPx = (value: number) => `${formatNumber(value)}px`;

const escapeHtmlAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeXmlAttribute = escapeHtmlAttribute;

const hasFiniteRegion = (
  layer: ModulePlanSharedLayer,
): layer is ModulePlanSharedLayer & {
  region: NonNullable<ModulePlanSharedLayer["region"]>;
} =>
  Boolean(
    layer.region &&
      Number.isFinite(layer.region.x) &&
      Number.isFinite(layer.region.y) &&
      Number.isFinite(layer.region.width) &&
      Number.isFinite(layer.region.height) &&
      layer.region.width > 0 &&
      layer.region.height > 0,
  );

const regionsIntersect = (
  a: NonNullable<ModulePlanSharedLayer["region"]>,
  b: Pick<SvgVerticalModule["region"], "height" | "width" | "x" | "y">,
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

const pathExists = async (filePath: string) => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
};

const unique = <T>(values: T[]) => [...new Set(values)];

const resolveSharedLayerSvgPath = async ({
  layer,
  moduleDir,
  modulePlan,
  modulePlanPath,
}: {
  layer: ModulePlanSharedLayer;
  moduleDir: string;
  modulePlan?: Pick<ModulePlan, "design" | "sharedLayers">;
  modulePlanPath?: string;
}) => {
  const sourceRefs = [layer.svgPath, layer.relativePath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!sourceRefs.length) return null;

  const planDir = modulePlanPath ? path.dirname(modulePlanPath) : path.dirname(moduleDir);
  const designDir =
    typeof modulePlan?.design?.svgPath === "string"
      ? path.dirname(modulePlan.design.svgPath)
      : undefined;
  const modulesDir = path.dirname(moduleDir);
  const candidates = unique(
    sourceRefs.flatMap((sourceRef) => [
      path.isAbsolute(sourceRef) ? path.normalize(sourceRef) : undefined,
      resolveConfiguredPath(sourceRef, planDir),
      designDir ? resolveConfiguredPath(sourceRef, designDir) : undefined,
      path.resolve(modulesDir, path.basename(sourceRef)),
    ]),
  ).filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
};

const collectLocalSharedLayers = async ({
  module,
  moduleDir,
  modulePlan,
  modulePlanPath,
  previewHtmlPath,
}: {
  module: Pick<SvgVerticalModule, "id" | "region">;
  moduleDir: string;
  modulePlan?: Pick<ModulePlan, "design" | "sharedLayers">;
  modulePlanPath?: string;
  previewHtmlPath?: string;
}): Promise<LocalSharedLayer[]> => {
  const layers = Array.isArray(modulePlan?.sharedLayers)
    ? modulePlan.sharedLayers
    : [];
  const normalized = await Promise.all(
    layers
      .filter(
        (layer) =>
          layer.kind === "shared-underlay" || layer.kind === "shared-overlay",
      )
      .filter(hasFiniteRegion)
      .filter((layer) => regionsIntersect(layer.region, module.region))
      .map(async (layer) => {
        const svgPath = await resolveSharedLayerSvgPath({
          layer,
          moduleDir,
          modulePlan,
          modulePlanPath,
        });
        if (!svgPath) return null;
        const htmlRefBase = previewHtmlPath
          ? path.dirname(previewHtmlPath)
          : moduleDir;
        const htmlRef = `./${path
          .relative(htmlRefBase, svgPath)
          .replaceAll(path.sep, "/")}`;
        return {
          htmlRef,
          id: layer.id,
          kind: layer.kind,
          region: layer.region,
          svgPath,
        };
      }),
  );
  return normalized.filter((layer): layer is LocalSharedLayer => Boolean(layer));
};

const getModuleLocalVerifyTargetSvgPath = (moduleDir: string, round: number) =>
  path.join(getModuleVerifyArtifactDir(moduleDir, round), "target.svg");

const getModuleLocalVerifyTargetHtmlPath = (moduleDir: string, round: number) =>
  path.join(getModuleVerifyArtifactDir(moduleDir, round), "target.html");

const getRelativeArtifactHref = (fromPath: string, assetPath: string) => {
  const relative = path
    .relative(path.dirname(fromPath), assetPath)
    .replaceAll(path.sep, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const renderTargetLayerMarkup = ({
  dataAttributes = "",
  href,
  height,
  kind,
  width,
  x,
  y,
  zIndex,
}: {
  dataAttributes?: string;
  height: number;
  href: string;
  kind: string;
  width: number;
  x: number;
  y: number;
  zIndex: number;
}) =>
  `<div class="module-local-target-layer" data-target-layer-kind="${escapeHtmlAttribute(kind)}"${dataAttributes} style="left:${formatPx(x)};top:${formatPx(y)};width:${formatPx(width)};height:${formatPx(height)};z-index:${zIndex}">
        <img class="module-local-target-layer__asset" src="${escapeHtmlAttribute(href)}" alt="" aria-hidden="true" />
      </div>`;

const buildModuleLocalVerifyTarget = async ({
  artifactDir,
  module,
  moduleSvgPath,
  scale,
  sharedLayers,
}: {
  artifactDir: string;
  module: Pick<SvgVerticalModule, "id" | "region">;
  moduleSvgPath: string;
  scale?: number;
  sharedLayers: LocalSharedLayer[];
}) => {
  if (!sharedLayers.length) {
    return {
      sourceSvgPath: moduleSvgPath,
      targetSvgPath: moduleSvgPath,
    };
  }

  const safeScale =
    typeof scale === "number" && Number.isFinite(scale) && scale > 0
      ? scale
      : 1;
  const targetSvgPath = path.join(artifactDir, "target.svg");
  const targetHtmlPath = path.join(artifactDir, "target.html");
  const sourceWidth = module.region.width / safeScale;
  const sourceHeight = module.region.height / safeScale;
  const renderLayer = (layer: LocalSharedLayer, zIndex: number) =>
    renderTargetLayerMarkup({
      dataAttributes: ` data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}"`,
      height: layer.region.height,
      href: getRelativeArtifactHref(targetHtmlPath, layer.svgPath),
      kind: layer.kind,
      width: layer.region.width,
      x: layer.region.x - module.region.x,
      y: layer.region.y - module.region.y,
      zIndex,
    });
  const underlays = sharedLayers
    .filter((layer) => layer.kind === "shared-underlay")
    .map((layer) => renderLayer(layer, 0));
  const overlays = sharedLayers
    .filter((layer) => layer.kind === "shared-overlay")
    .map((layer) => renderLayer(layer, 20));
  const moduleImage = renderTargetLayerMarkup({
    dataAttributes: ` data-module-id="${escapeHtmlAttribute(module.id)}"`,
    height: module.region.height,
    href: getRelativeArtifactHref(targetHtmlPath, moduleSvgPath),
    kind: "module",
    width: module.region.width,
    x: 0,
    y: 0,
    zIndex: 10,
  });

  await writeTextFile(
    targetSvgPath,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${formatNumber(sourceWidth)}" height="${formatNumber(sourceHeight)}" viewBox="0 0 ${formatNumber(sourceWidth)} ${formatNumber(sourceHeight)}" overflow="hidden" data-module-local-verify-target="${escapeXmlAttribute(module.id)}">
  <metadata>Composite module-local verify target is rendered from target.html to allow shared SVG layers to load as document resources.</metadata>
</svg>
`,
  );
  await writeTextFile(
    targetHtmlPath,
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${formatNumber(module.region.width)}, initial-scale=1" />
    <style>
      html,
      body {
        margin: 0;
        width: ${formatPx(module.region.width)};
        height: ${formatPx(module.region.height)};
        overflow: hidden;
        background: transparent;
      }

      .module-local-target-page {
        position: relative;
        width: ${formatPx(module.region.width)};
        height: ${formatPx(module.region.height)};
        overflow: hidden;
        background: transparent;
      }

      .module-local-target-layer {
        position: absolute;
        overflow: hidden;
      }

      .module-local-target-layer__asset {
        display: block;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <main class="module-local-target-page" data-module-local-verify-target="${escapeHtmlAttribute(module.id)}">
      ${[...underlays, moduleImage, ...overlays].join("\n      ")}
    </main>
  </body>
</html>
`,
  );
  return {
    sourceHtmlPath: targetHtmlPath,
    sourceSvgPath: targetSvgPath,
    targetHtmlPath,
    targetSvgPath,
  };
};

const renderSharedLayerMarkup = ({
  layer,
  moduleX,
  moduleY,
}: {
  layer: LocalSharedLayer;
  moduleX: number;
  moduleY: number;
}) =>
  `<div class="module-local-shared-layer" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style="left:${formatPx(layer.region.x - moduleX)};top:${formatPx(layer.region.y - moduleY)};width:${formatPx(layer.region.width)};height:${formatPx(layer.region.height)}">
        <img class="module-local-shared-layer__asset" src="${escapeHtmlAttribute(layer.htmlRef)}" alt="" aria-hidden="true" />
      </div>`;

const buildModulePreviewHtml = ({
  fragmentCss,
  fragmentHtml,
  height,
  moduleId,
  moduleX,
  moduleY,
  scaffoldStyles,
  sharedLayers,
  width,
}: {
  fragmentCss: string;
  fragmentHtml: string;
  height: number;
  moduleId: string;
  moduleX: number;
  moduleY: number;
  scaffoldStyles: string;
  sharedLayers: LocalSharedLayer[];
  width: number;
}) => {
  const underlayMarkup = sharedLayers
    .filter((layer) => layer.kind === "shared-underlay")
    .map((layer) => renderSharedLayerMarkup({ layer, moduleX, moduleY }))
    .join("\n      ");
  const overlayMarkup = sharedLayers
    .filter((layer) => layer.kind === "shared-overlay")
    .map((layer) => renderSharedLayerMarkup({ layer, moduleX, moduleY }))
    .join("\n      ");
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

      .module-local-shared-layer {
        position: absolute;
        overflow: hidden;
        pointer-events: none;
        user-select: none;
      }

      .module-local-shared-layer[data-shared-layer-kind="shared-underlay"] {
        z-index: 0;
      }

      .module-local-shared-layer[data-shared-layer-kind="shared-overlay"] {
        z-index: 20;
      }

      .module-local-shared-layer__asset {
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
      .module-local-shared-layer,
      .module-local-shared-layer *,
      .design-module * {
        box-sizing: border-box;
      }

${fragmentCss
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    </style>
  </head>
  <body>
    <main class="design-page">
      ${underlayMarkup}
      <section class="design-module ${moduleId}" data-module-id="${moduleId}">
${fragmentHtml
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
      </section>
      ${overlayMarkup}
    </main>
  </body>
</html>
`;
};

const getModulePreviewHtmlPath = (moduleDir: string, round: number) =>
  path.join(moduleDir, `module-preview-round-${round}.html`);

const getModuleVerifyArtifactDir = (moduleDir: string, round: number) =>
  path.join(moduleDir, "verify", `round-${round}`);

const readCachedModuleLocalVerify = async ({
  module,
  moduleDir,
  modulePlan,
  modulePlanPath,
  moduleSvgPath,
  round,
  scaffoldHtmlPath,
}: ModuleLocalVerifyCacheInput): Promise<ModuleLocalVerifyResult | null> => {
  const artifactDir = getModuleVerifyArtifactDir(moduleDir, round);
  const previewHtmlPath = getModulePreviewHtmlPath(moduleDir, round);
  const sharedLayers = await collectLocalSharedLayers({
    module,
    moduleDir,
    modulePlan,
    modulePlanPath,
    previewHtmlPath,
  });
  const targetSvgPath = sharedLayers.length
    ? getModuleLocalVerifyTargetSvgPath(moduleDir, round)
    : moduleSvgPath;
  const targetHtmlPath = sharedLayers.length
    ? getModuleLocalVerifyTargetHtmlPath(moduleDir, round)
    : undefined;
  const verifyReportPath = path.join(artifactDir, "verify-report.fast.json");
  const renderReportPath = path.join(artifactDir, "render-report.json");
  const inputPaths = [
    path.join(moduleDir, "fragment.html"),
    path.join(moduleDir, "fragment.css"),
    path.join(moduleDir, "allowed-assets.json"),
    ...(modulePlanPath ? [modulePlanPath] : []),
    ...sharedLayers.map((layer) => layer.svgPath),
    moduleSvgPath,
    targetSvgPath,
    ...(targetHtmlPath ? [targetHtmlPath] : []),
    scaffoldHtmlPath,
  ];

  try {
    const assetInputPaths = await collectExistingFilePaths(
      path.join(moduleDir, "assets"),
    );
    const [reportStat, inputStats] = await Promise.all([
      stat(verifyReportPath),
      Promise.all(
        [...inputPaths, ...assetInputPaths].map((inputPath) => stat(inputPath)),
      ),
    ]);
    const newestInputMtime = Math.max(
      ...inputStats.map((inputStat) => inputStat.mtimeMs),
    );
    if (reportStat.mtimeMs < newestInputMtime) return null;

    const [report, renderReport] = await Promise.all([
      readJson<FastVerifyReport>(verifyReportPath),
      readJson<RenderReport>(renderReportPath),
    ]);
    if (renderReport.width !== Math.round(module.region.width)) return null;
    if (renderReport.height !== Math.round(module.region.height)) return null;
    if (sharedLayers.length && renderReport.sourceRenderMode !== "html") return null;
    if (report.sourceImageIntegrityPassed === false) return null;
    if (renderReport.sourceImageIntegrityPassed === false) return null;
    if (report.sourceImageErrors?.length || renderReport.sourceImageErrors?.length) {
      return null;
    }
    if (typeof report.diffRatio !== "number") return null;

    return {
      artifactDir,
      diffPixels: report.diffPixels,
      diffPngPath: report.diffPngPath ?? path.join(artifactDir, "diff.png"),
      diffRatio: report.diffRatio,
      htmlPath: previewHtmlPath,
      htmlPngPath: report.htmlPngPath ?? path.join(artifactDir, "html.png"),
      moduleId: module.id,
      passed: report.diffRatio <= MODULE_DIFF_RATIO_THRESHOLD,
      svgPngPath: report.svgPngPath ?? path.join(artifactDir, "svg.png"),
      targetHtmlPath,
      targetSvgPath,
      verifyReportPath,
    };
  } catch {
    return null;
  }
};

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
  const [fragmentHtml, fragmentCss, scaffoldHtml, allowedAssets] =
    await Promise.all([
      readFile(path.join(moduleDir, "fragment.html"), "utf8"),
      readFile(path.join(moduleDir, "fragment.css"), "utf8"),
      readFile(scaffoldHtmlPath, "utf8"),
      readAllowedAssets(moduleDir),
    ]);
  const previewHtmlPath = getModulePreviewHtmlPath(moduleDir, round);
  const artifactDir = getModuleVerifyArtifactDir(moduleDir, round);
  const sharedLayers = await collectLocalSharedLayers({
    module,
    moduleDir,
    modulePlan,
    modulePlanPath,
    previewHtmlPath,
  });
  if (sharedLayers.length) {
    onProgress?.(
      `Local verify includes shared layers: ${sharedLayers
        .map((layer) => `${layer.id}:${layer.kind}`)
        .join(", ")}`,
    );
  }
  const previewFragmentHtml = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: fragmentHtml,
    moduleDir,
    outputHtmlPath: previewHtmlPath,
  });
  const previewFragmentCss = rewriteModuleLocalAssetReferences({
    allowedAssets,
    content: fragmentCss,
    moduleDir,
    outputHtmlPath: previewHtmlPath,
  });
  await writeTextFile(
    previewHtmlPath,
    buildModulePreviewHtml({
      fragmentCss: previewFragmentCss,
      fragmentHtml: previewFragmentHtml,
      height: module.region.height,
      moduleId: module.id,
      moduleX: module.region.x,
      moduleY: module.region.y,
      scaffoldStyles: extractScaffoldStyleBlocks(scaffoldHtml),
      sharedLayers,
      width: module.region.width,
    }),
  );
  const target = await buildModuleLocalVerifyTarget({
    artifactDir,
    module,
    moduleSvgPath,
    scale,
    sharedLayers,
  });

  const result = await verifyDesign(
    target.sourceSvgPath,
    onProgress,
    artifactDir,
    undefined,
    {
      htmlPath: previewHtmlPath,
      mode: "fast",
      runFinalOutputPolicy: false,
      scale,
      sourceHtmlPath: target.sourceHtmlPath,
    },
  );
  if (result.sourceImageIntegrityPassed === false) {
    const failedRefs = (result.sourceImageErrors ?? [])
      .map((issue) => issue.src || issue.currentSrc || "(empty)")
      .join(", ");
    throw new Error(
      `module-local verify source target image load failed${failedRefs ? `: ${failedRefs}` : ""}`,
    );
  }

  return {
    artifactDir: result.artifactDir,
    diffPngPath: result.diffPngPath,
    diffPixels: undefined,
    diffRatio: result.diffRatio,
    htmlPath: previewHtmlPath,
    htmlPngPath: result.htmlPngPath,
    moduleId: module.id,
    passed: result.diffRatio <= MODULE_DIFF_RATIO_THRESHOLD,
    svgPngPath: result.svgPngPath,
    targetHtmlPath: target.targetHtmlPath,
    targetSvgPath: target.targetSvgPath,
    verifyReportPath: result.verifyReportPath,
  };
};

export type { ModuleLocalVerifyResult };
export { readCachedModuleLocalVerify, verifyModuleLocal };
