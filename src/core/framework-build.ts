import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import { build } from "vite";

import { writeTextFile } from "./file-io.js";

type FrameworkFormat = "vue" | "react";
type FrameworkMountId = "app" | "root";

type WriteFrameworkEntryFilesInput = {
  designName: string;
  entryDir: string;
  format: FrameworkFormat;
  height: number;
  sourceEntryPath: string;
  sourceStylePath?: string;
  srcDir: string;
  width: number;
};

type BuildFrameworkProjectInput = {
  distDir: string;
  entryDir: string;
  format: FrameworkFormat;
};

type InlineFrameworkDistHtmlInput = {
  distAssetsDir: string;
  distDir: string;
  distHtml: string;
  renderEntryPath: string;
};

const getFrameworkMountId = (format: FrameworkFormat): FrameworkMountId =>
  format === "vue" ? "app" : "root";

const normalizeImportPath = (fromDir: string, targetPath: string) => {
  let relative = path.relative(fromDir, targetPath).replaceAll(path.sep, "/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
};

const toRenderRelativeAssetBase = ({
  distAssetsDir,
  renderEntryPath,
}: {
  distAssetsDir: string;
  renderEntryPath: string;
}) => {
  let assetRef = path
    .relative(path.dirname(renderEntryPath), distAssetsDir)
    .replaceAll(path.sep, "/");
  if (!assetRef.startsWith(".")) assetRef = `./${assetRef}`;
  return assetRef;
};

const splitRefSuffix = (ref: string) => {
  const queryIndex = ref.search(/[?#]/);
  if (queryIndex < 0) return { cleanRef: ref, suffix: "" };
  return {
    cleanRef: ref.slice(0, queryIndex),
    suffix: ref.slice(queryIndex),
  };
};

const isExternalRef = (ref: string) => {
  const normalized = ref.trim().toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("//") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("blob:") ||
    normalized.startsWith("javascript:") ||
    normalized.startsWith("#") ||
    normalized.startsWith("/")
  );
};

const toInlineAssetRef = (ref: string, assetBaseRef: string) => {
  if (isExternalRef(ref)) return ref;
  const { cleanRef, suffix } = splitRefSuffix(ref);
  const withoutDotSlash = cleanRef.replace(/^\.\//, "");
  const withoutAssetsPrefix = withoutDotSlash.replace(/^assets\//, "");
  return `${assetBaseRef}/${withoutAssetsPrefix}${suffix}`;
};

const resolveDistRef = (distDir: string, ref: string) => {
  const { cleanRef } = splitRefSuffix(ref);
  return path.resolve(distDir, cleanRef);
};

const escapeInlineScript = (value: string) =>
  value.replace(/<\/script/gi, "<\\/script");

const escapeInlineStyle = (value: string) =>
  value.replace(/<\/style/gi, "<\\/style");

const rewriteCssAssetRefs = ({
  assetBaseRef,
  css,
}: {
  assetBaseRef: string;
  css: string;
}) =>
  css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, quote, ref) => {
    const nextRef = toInlineAssetRef(String(ref).trim(), assetBaseRef);
    if (nextRef === ref) return match;
    return `url(${quote}${nextRef}${quote})`;
  });

const rewriteJsAssetRefs = ({
  assetBaseRef,
  js,
}: {
  assetBaseRef: string;
  js: string;
}) =>
  js.replace(
    /new URL\((["'`])([^"'`]+)\1,\s*import\.meta\.url\)/g,
    (match, quote, ref) => {
      const nextRef = toInlineAssetRef(String(ref).trim(), assetBaseRef);
      if (nextRef === ref) return match;
      return `new URL(${quote}${nextRef}${quote},import.meta.url)`;
    },
  );

const getAttrValue = (tag: string, attr: string) => {
  const match = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
};

const hasRel = (tag: string, rel: string) => {
  const relValue = getAttrValue(tag, "rel");
  return relValue
    .split(/\s+/)
    .some((value) => value.toLowerCase() === rel.toLowerCase());
};

const createVueEntry = ({
  entryDir,
  sourceEntryPath,
}: {
  entryDir: string;
  sourceEntryPath: string;
}) => `\
import { createApp } from "vue";
import App from "${normalizeImportPath(entryDir, sourceEntryPath)}";

createApp(App).mount("#app");
`;

const createReactEntry = ({
  entryDir,
  sourceEntryPath,
  sourceStylePath,
}: {
  entryDir: string;
  sourceEntryPath: string;
  sourceStylePath?: string;
}) => `\
${[
  'import React from "react";',
  'import { createRoot } from "react-dom/client";',
  `import App from "${normalizeImportPath(entryDir, sourceEntryPath)}";`,
  sourceStylePath
    ? `import "${normalizeImportPath(entryDir, sourceStylePath)}";`
    : "",
]
  .filter(Boolean)
  .join("\n")}

createRoot(document.getElementById("root")!).render(<App />);
`;

const createFrameworkIndexHtml = ({
  designName,
  height,
  mountId,
  width,
}: {
  designName: string;
  height: number;
  mountId: FrameworkMountId;
  width: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1.0" />
    <title>${designName}</title>
    <style>
      html, body, #${mountId} {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }
    </style>
  </head>
  <body>
    <div id="${mountId}"></div>
    <script type="module" src="/src/main.${mountId === "app" ? "ts" : "tsx"}"></script>
  </body>
</html>
`;

const writeFrameworkEntryFiles = async ({
  designName,
  entryDir,
  format,
  height,
  sourceEntryPath,
  sourceStylePath,
  srcDir,
  width,
}: WriteFrameworkEntryFilesInput) => {
  const mountId = getFrameworkMountId(format);
  const mainEntryPath = path.join(
    srcDir,
    `main.${format === "vue" ? "ts" : "tsx"}`,
  );
  const indexHtmlPath = path.join(entryDir, "index.html");

  await mkdir(srcDir, { recursive: true });
  await Promise.all([
    writeTextFile(
      mainEntryPath,
      format === "vue"
        ? createVueEntry({ entryDir: srcDir, sourceEntryPath })
        : createReactEntry({ entryDir: srcDir, sourceEntryPath, sourceStylePath }),
    ),
    writeTextFile(
      indexHtmlPath,
      createFrameworkIndexHtml({ designName, height, mountId, width }),
    ),
  ]);

  return { indexHtmlPath, mainEntryPath, mountId };
};

const buildFrameworkProject = async ({
  distDir,
  entryDir,
  format,
}: BuildFrameworkProjectInput) => {
  await build({
    base: "./",
    build: {
      assetsInlineLimit: 0,
      assetsDir: "assets",
      emptyOutDir: true,
      outDir: distDir,
    },
    configFile: false,
    logLevel: "warn",
    plugins: format === "vue" ? [vue()] : [react()],
    resolve: {
      alias: [],
    },
    root: entryDir,
  });
};

const inlineFrameworkDistHtml = async ({
  distAssetsDir,
  distDir,
  distHtml,
  renderEntryPath,
}: InlineFrameworkDistHtmlInput) => {
  const assetBaseRef = toRenderRelativeAssetBase({
    distAssetsDir,
    renderEntryPath,
  });
  let html = distHtml;

  const stylesheetTags = [
    ...html.matchAll(/<link\b[^>]*\bhref=["'][^"']+["'][^>]*>/gi),
  ]
    .map((match) => match[0])
    .filter((tag) => hasRel(tag, "stylesheet"));

  for (const tag of stylesheetTags) {
    const href = getAttrValue(tag, "href");
    if (!href || isExternalRef(href)) continue;
    const css = await readFile(resolveDistRef(distDir, href), "utf8");
    html = html.replace(
      tag,
      () =>
        `<style data-framework-bundle="css">\n${escapeInlineStyle(
          rewriteCssAssetRefs({ assetBaseRef, css }),
        )}\n</style>`,
    );
  }

  const modulePreloadTags = [
    ...html.matchAll(/<link\b[^>]*\bhref=["'][^"']+["'][^>]*>/gi),
  ]
    .map((match) => match[0])
    .filter((tag) => hasRel(tag, "modulepreload"));
  for (const tag of modulePreloadTags) {
    html = html.replace(tag, () => "");
  }

  const scriptTags = [
    ...html.matchAll(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi),
  ].map((match) => match[0]);

  for (const tag of scriptTags) {
    const src = getAttrValue(tag, "src");
    if (!src || isExternalRef(src)) continue;
    const js = await readFile(resolveDistRef(distDir, src), "utf8");
    html = html.replace(
      tag,
      () =>
        `<script type="module" data-framework-bundle="js">\n${escapeInlineScript(
          rewriteJsAssetRefs({ assetBaseRef, js }),
        )}\n</script>`,
    );
  }

  return html;
};

export {
  buildFrameworkProject,
  inlineFrameworkDistHtml,
  writeFrameworkEntryFiles,
};
export type { FrameworkFormat };
