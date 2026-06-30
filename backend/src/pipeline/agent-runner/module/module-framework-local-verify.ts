import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  buildFrameworkProject,
  writeFrameworkEntryFiles,
  type FrameworkFormat,
} from "../../../core/framework-build.js";
import { isRecord } from "../../../core/type-guards.js";
import { writeTextFile } from "../../../core/file-io.js";
import type { SvgVerticalModule } from "../../../core/svg-vertical-modules/types.js";
import {
  normalizeSourceFragment,
  rewriteModuleLocalAssetReferences,
  rewriteModuleLocalAssetReferencesInValue,
} from "../../module-merge/html-render.js";
import type { ModuleFragmentManifest } from "../../module-merge/types.js";
import { getModuleDiffRatioThreshold } from "../../../config/index.js";
import { readModuleAllowedAssets } from "./module-semantic.js";
import { verifyDesign } from "../../verify.js";

type ModuleFrameworkLocalVerifyResult = {
  artifactDir: string;
  buildError?: string;
  diffPngPath?: string;
  diffPixels?: number;
  diffRatio: number;
  passed: boolean;
  renderEntryPath?: string;
  renderPngPath?: string;
  svgPngPath?: string;
};

const readJsonFile = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const collectGeneratedAssetRefs = (manifest: ModuleFragmentManifest): string[] => {
  const refs: string[] = [];
  // producedAssets 是脚本 finalizeModuleManifest 标准化后的唯一资产字段
  for (const key of ["producedAssets"] as const) {
    const collection = manifest[key];
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!isRecord(item)) continue;
      for (const refKey of ["path", "relativePath", "htmlRef"] as const) {
        const ref = item[refKey];
        if (typeof ref === "string") refs.push(ref);
      }
    }
  }
  return refs;
};

const jsLiteral = (value: unknown) =>
  JSON.stringify(value ?? null, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Build the per-module `sourceData` declaration for framework local verify.
 *
 * The whole source-data.json object is exposed as a `sourceData` constant keyed
 * by module id, mirroring the page-level merge contract so the agent's source
 * fragment (`sourceData["<moduleId>"].xxx`) behaves identically in verify and
 * in the final build. Returns an empty string when there is no usable data so
 * the rendered entry stays valid.
 */
const buildModuleSourceDataStatement = ({
  moduleId,
  sourceData,
}: {
  moduleId: string;
  sourceData?: unknown;
}): string => {
  if (!sourceData || !isRecord(sourceData)) return "";
  if (Object.keys(sourceData).length === 0) return "";
  const wrapped = { [moduleId]: sourceData };
  return `const sourceData = ${jsLiteral(wrapped)};`;
};

const formatPx = (value: number) =>
  Number.isInteger(value) ? `${value}px` : `${value.toFixed(3)}px`;

const buildVueModuleEntry = async ({
  moduleCss,
  moduleId,
  region,
  sourceData,
  sourceFragment,
}: {
  moduleCss: string;
  moduleId: string;
  region: SvgVerticalModule["region"];
  sourceData?: unknown;
  sourceFragment: string;
}) => {
  const sourceDataStatement = buildModuleSourceDataStatement({
    moduleId,
    sourceData,
  });
  const template = `
<template>
  <main class="design-page">
    <section class="design-module ${moduleId}" data-module-id="${moduleId}" style="position:absolute;left:0;top:0;width:${formatPx(region.width)};height:${formatPx(region.height)};overflow:hidden;">
${sourceFragment.trim()}
    </section>
  </main>
</template>

<script setup lang="ts">
${[
  sourceDataStatement,
]
  .filter((line): line is string => Boolean(line))
  .join("\n")}
</script>

<style>
html, body, #app {
  margin: 0;
  width: ${formatPx(region.width)};
  height: ${formatPx(region.height)};
  overflow: hidden;
}
.design-page {
  position: relative;
  width: ${formatPx(region.width)};
  height: ${formatPx(region.height)};
  overflow: hidden;
}
${moduleCss}
</style>
`.trim();
  return template;
};

const buildReactModuleEntry = async ({
  moduleCss,
  moduleId,
  region,
  sourceData,
  sourceFragment,
}: {
  moduleCss: string;
  moduleId: string;
  region: SvgVerticalModule["region"];
  sourceData?: unknown;
  sourceFragment: string;
}) => {
  const sourceDataStatement = buildModuleSourceDataStatement({
    moduleId,
    sourceData,
  });
  const jsx = `
import React from "react";

export default function ModulePage() {
${sourceDataStatement ? `  ${sourceDataStatement}\n` : ""}\
  return (
    <main className="design-page">
      <section className="design-module ${moduleId}" data-module-id="${moduleId}" style={{ position: "absolute", left: 0, top: 0, width: "${formatPx(region.width)}", height: "${formatPx(region.height)}", overflow: "hidden" }}>
${sourceFragment.trim()}
      </section>
    </main>
  );
}
`.trim();
  return { jsx, moduleCss };
};

const getFrameworkVerifyArtifactDir = (moduleDir: string, round: number) =>
  path.join(moduleDir, "verify", `framework-round-${round}`);

export const verifyModuleFrameworkLocal = async ({
  design,
  module,
  moduleDir,
  moduleSvgPath,
  onProgress,
  onRenderEntryReady,
  outputFormat,
  round,
  signal,
}: {
  design: { scale?: number; width: number; height: number };
  module: SvgVerticalModule;
  moduleDir: string;
  moduleSvgPath: string;
  onProgress?: (message: string) => void;
  onRenderEntryReady?: (renderEntryPath: string) => void;
  outputFormat?: "vue" | "react";
  round: number;
  signal?: AbortSignal;
}): Promise<ModuleFrameworkLocalVerifyResult | null> => {
  const frameworkFormat: FrameworkFormat | null = outputFormat ?? null;
  if (!frameworkFormat) return null;

  const artifactDir = getFrameworkVerifyArtifactDir(moduleDir, round);
  const manifestPath = path.join(moduleDir, "manifest.json");
  const manifest = (await readJsonFile<ModuleFragmentManifest>(manifestPath)) ?? {};

  // The explicit `outputFormat` path builds+verifies regardless of component
  // usage so plain Vue/React sessions are exercised end-to-end.

  const sourceFragmentFileName =
    frameworkFormat === "vue"
      ? "source.fragment.vue.html"
      : "source.fragment.jsx";
  const sourceFragmentPath = path.join(moduleDir, sourceFragmentFileName);
  const sourceDataPath = path.join(moduleDir, "source-data.json");
  const cssPath = path.join(moduleDir, "module.css");

  const allowedAssetsRaw = await readModuleAllowedAssets(moduleDir);

  const [sourceFragmentRaw, sourceDataRaw, cssRaw] = await Promise.all([
    readFile(sourceFragmentPath, "utf8").catch(() => undefined),
    readFile(sourceDataPath, "utf8").catch(() => undefined),
    readFile(cssPath, "utf8").catch(() => ""),
  ]);

  if (!sourceFragmentRaw) {
    throw new Error(
      `${module.id} framework local verify requires ${sourceFragmentFileName}`,
    );
  }

  const sourceFragment = normalizeSourceFragment(sourceFragmentRaw, frameworkFormat);
  const sourceData = sourceDataRaw
    ? (JSON.parse(sourceDataRaw) as unknown)
    : undefined;

  const entryDir = path.join(artifactDir, "entry");
  const srcDir = path.join(entryDir, "src");
  const distDir = path.join(entryDir, "dist");
  await rm(artifactDir, { force: true, recursive: true });

  const semanticAssetRefs = (allowedAssetsRaw ?? [])
    .flatMap((asset) => [
      asset.path,
      asset.relativePath,
      asset.htmlRef,
      asset.assetPath,
      asset.svgPath,
      asset.pngPath,
      asset.webpPath,
      asset.jpgPath,
      asset.jpegPath,
      asset.avifPath,
    ])
    .filter((ref): ref is string => typeof ref === "string");
  const moduleLocalAssetRefs = [
    ...collectGeneratedAssetRefs(manifest),
    ...semanticAssetRefs,
  ];
  const moduleRenderEntryPath = path.join(srcDir, `Module.${frameworkFormat === "vue" ? "vue" : "tsx"}`);

  const rewrittenSourceFragment = rewriteModuleLocalAssetReferences({
    allowedAssets: allowedAssetsRaw ?? [],
    content: sourceFragment,
    moduleDir,
    moduleLocalAssetRefs,
    renderEntryPath: moduleRenderEntryPath,
  });

  const rewrittenCss = rewriteModuleLocalAssetReferences({
    allowedAssets: allowedAssetsRaw ?? [],
    content: cssRaw,
    moduleDir,
    moduleLocalAssetRefs,
    renderEntryPath: moduleRenderEntryPath,
  });

  // Rewrite asset references inside source-data.json too, mirroring the merge
  // pipeline. Without this the agent must guess the final relative path and
  // routinely gets it wrong (e.g. `../../../../assets/x.png`); verify and final
  // build then diverge.
  const rewrittenSourceData =
    sourceData === undefined
      ? undefined
      : rewriteModuleLocalAssetReferencesInValue({
          allowedAssets: allowedAssetsRaw ?? [],
          moduleDir,
          moduleLocalAssetRefs,
          renderEntryPath: moduleRenderEntryPath,
          value: sourceData,
        });

  if (frameworkFormat === "vue") {
    const vueSource = await buildVueModuleEntry({
      moduleCss: rewrittenCss,
      moduleId: module.id,
      region: module.region,
      sourceData: rewrittenSourceData,
      sourceFragment: rewrittenSourceFragment,
    });
    await writeTextFile(path.join(srcDir, "Module.vue"), vueSource);
  } else {
    const { jsx, moduleCss } = await buildReactModuleEntry({
      moduleCss: rewrittenCss,
      moduleId: module.id,
      region: module.region,
      sourceData: rewrittenSourceData,
      sourceFragment: rewrittenSourceFragment,
    });
    await writeTextFile(path.join(srcDir, "Module.tsx"), jsx);
    await writeTextFile(path.join(srcDir, "Module.css"), moduleCss);
  }

  await writeFrameworkEntryFiles({
    designName: module.id,
    entryDir,
    format: frameworkFormat,
    height: module.region.height,
    sourceEntryPath: path.join(
      srcDir,
      `Module.${frameworkFormat === "vue" ? "vue" : "tsx"}`,
    ),
    sourceStylePath:
      frameworkFormat === "react" ? path.join(srcDir, "Module.css") : undefined,
    srcDir,
    width: module.region.width,
  });

  try {
    await buildFrameworkProject({
      distDir,
      entryDir,
      format: frameworkFormat,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(
      `${module.id} framework local build failed: ${message.slice(0, 400)}`,
    );
    return {
      artifactDir,
      buildError: message,
      diffRatio: 1,
      passed: false,
    };
  }

  const distHtmlPath = path.join(distDir, "index.html");

  const frameworkRenderEntryPath = distHtmlPath;
  onRenderEntryReady?.(frameworkRenderEntryPath);

  const result = await verifyDesign(
    moduleSvgPath,
    onProgress,
    artifactDir,
    {
      mode: "fast",
      renderEntryPath: frameworkRenderEntryPath,
      scale: design.scale,
      signal,
    },
  );

  return {
    artifactDir: result.artifactDir,
    diffPngPath: result.diffPngPath,
    diffRatio: result.diffRatio,
    passed: result.diffRatio <= getModuleDiffRatioThreshold(),
    renderEntryPath: frameworkRenderEntryPath,
    renderPngPath: result.renderPngPath,
    svgPngPath: result.svgPngPath,
  };
};
