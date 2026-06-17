import { existsSync } from "node:fs";
import path from "node:path";

import { safeDecodeUri } from "../../core/io.js";
import {
  MODULE_LOCAL_ASSET_DIR,
  getAllowedAssetPathValues,
  isPathInside,
  isSupportedModuleAssetPath,
  normalizeSlashes,
  type ModuleOutputAllowedAsset,
} from "../module-output-policy.js";
import type {
  ModuleMergeResolvedModule,
  ModulePlanSharedLayer,
} from "./types.js";
import { scopeCss } from "./css.js";
import {
  escapeRegExp,
  formatPx,
  formatRegionStyle,
  indent,
  normalizePathForCompare,
} from "./utils.js";

const MODULE_CSS_STYLE_START = "<style data-module-merge-generated>";
const MODULE_CSS_STYLE_END = "</style>";

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const splitAssetRef = (value: string) => {
  const decoded = safeDecodeUri(value.trim()).replace(/^file:\/\//, "");
  const suffixStart = decoded.search(/[?#]/);
  if (suffixStart === -1) return { pathPart: decoded, suffix: "" };
  return {
    pathPart: decoded.slice(0, suffixStart),
    suffix: decoded.slice(suffixStart),
  };
};

const formatRelativeAssetRef = (value: string) => {
  const normalized = normalizeSlashes(value);
  if (
    !normalized ||
    normalized.startsWith(".") ||
    normalized.startsWith("/") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(normalized)
  ) {
    return normalized;
  }
  return `./${normalized}`;
};

const addAssetRefAliases = ({
  assetPath,
  map,
  moduleDir,
  renderEntryPath,
  ref,
}: {
  assetPath: string;
  map: Map<string, string>;
  moduleDir: string;
  renderEntryPath: string;
  ref: string;
}) => {
  const htmlDir = path.dirname(renderEntryPath);
  const aliases = [
    ref,
    assetPath,
    path.relative(moduleDir, assetPath),
    path.relative(htmlDir, assetPath),
    `./${path.relative(moduleDir, assetPath)}`,
    `./${path.relative(htmlDir, assetPath)}`,
  ];

  for (const alias of aliases) {
    map.set(normalizePathForCompare(alias), assetPath);
    map.set(
      normalizeSlashes(alias).replace(/^\.\//, "").toLowerCase(),
      assetPath,
    );
  }
};

const addDeclaredAssetRefToMap = ({
  map,
  moduleDir,
  renderEntryPath,
  ref,
}: {
  map: Map<string, string>;
  moduleDir: string;
  renderEntryPath: string;
  ref: string;
}) => {
  const assetPath = resolveDeclaredAssetPath({
    moduleDir,
    renderEntryPath,
    ref,
  });
  if (!assetPath) return;
  addAssetRefAliases({
    assetPath,
    map,
    moduleDir,
    renderEntryPath,
    ref,
  });
};

const resolveDeclaredAssetPath = ({
  moduleDir,
  renderEntryPath,
  ref,
}: {
  moduleDir: string;
  renderEntryPath: string;
  ref: string;
}) => {
  const { pathPart: cleaned } = splitAssetRef(ref);
  if (
    !cleaned ||
    cleaned.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned) ||
    !isSupportedModuleAssetPath(cleaned)
  ) {
    return null;
  }

  const htmlDir = path.dirname(renderEntryPath);
  const assetDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR);
  const candidates = path.isAbsolute(cleaned)
    ? [path.resolve(cleaned)]
    : [
        path.resolve(moduleDir, cleaned),
        path.resolve(htmlDir, cleaned),
        path.resolve(process.cwd(), cleaned),
      ];
  return (
    candidates.find(
      (candidate) =>
        existsSync(candidate) &&
        (isPathInside(candidate, assetDir) ||
          !isPathInside(candidate, moduleDir)),
    ) ?? null
  );
};

const buildDeclaredAssetMap = ({
  allowedAssets,
  declaredAssetRefs,
  moduleDir,
  renderEntryPath,
}: {
  allowedAssets?: ModuleOutputAllowedAsset[];
  declaredAssetRefs?: string[];
  moduleDir: string;
  renderEntryPath: string;
}) => {
  const map = new Map<string, string>();
  for (const ref of declaredAssetRefs ?? []) {
    addDeclaredAssetRefToMap({
      map,
      moduleDir,
      renderEntryPath,
      ref,
    });
  }
  for (const asset of allowedAssets ?? []) {
    const refs = getAllowedAssetPathValues(asset);
    const assetPath =
      refs
        .map((ref) =>
          resolveDeclaredAssetPath({ moduleDir, renderEntryPath, ref }),
        )
        .find((value): value is string => Boolean(value)) ?? null;
    if (!assetPath) continue;
    for (const ref of refs) {
      addAssetRefAliases({
        assetPath,
        map,
        moduleDir,
        renderEntryPath,
        ref,
      });
    }
  }
  return map;
};

const resolveDeclaredAssetRef = ({
  declaredAssetMap,
  renderEntryPath,
  ref,
}: {
  declaredAssetMap: Map<string, string>;
  renderEntryPath: string;
  ref: string;
}) => {
  const { pathPart, suffix } = splitAssetRef(ref);
  const assetPath =
    declaredAssetMap.get(normalizePathForCompare(pathPart)) ??
    declaredAssetMap.get(
      normalizeSlashes(pathPart).replace(/^\.\//, "").toLowerCase(),
    );
  if (!assetPath) return null;
  return `${formatRelativeAssetRef(path.relative(path.dirname(renderEntryPath), assetPath))}${suffix}`;
};

const rewriteModuleLocalAssetReferences = ({
  allowedAssets,
  content,
  moduleDir,
  moduleLocalAssetRefs,
  renderEntryPath,
}: {
  allowedAssets?: ModuleOutputAllowedAsset[];
  content: string;
  moduleDir: string;
  moduleLocalAssetRefs?: string[];
  renderEntryPath: string;
}) => {
  const declaredAssetMap = buildDeclaredAssetMap({
    allowedAssets,
    declaredAssetRefs: moduleLocalAssetRefs,
    moduleDir,
    renderEntryPath,
  });
  const rewriteRef = (ref: string) =>
    resolveDeclaredAssetRef({
      declaredAssetMap,
      renderEntryPath,
      ref,
    }) ?? ref;

  /**
   * Strip wrapping quotes from a captured ref value.
   * Handles Vue-style `:src="'path'"` where the regex captures
   * `'path'` (with inner quotes) as the ref.
   */
  const stripInnerQuotes = (ref: string): { inner: string; quoted: boolean } => {
    const trimmed = ref.trim();
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      return { inner: trimmed.slice(1, -1), quoted: true };
    }
    return { inner: ref, quoted: false };
  };

  const rewriteRefWithQuoteAwareness = (ref: string) => {
    // Try direct rewrite first (handles normal src="./assets/x.png")
    const direct = rewriteRef(ref);
    if (direct !== ref) return direct;
    // If direct rewrite returned unchanged, try stripping inner quotes
    // (handles Vue :src="'./assets/x.png'" where ref = "'./assets/x.png'")
    const { inner, quoted } = stripInnerQuotes(ref);
    if (!quoted) return ref;
    const rewritten = rewriteRef(inner);
    if (rewritten !== inner) return `'${rewritten}'`;
    return ref;
  };

  // Compute the correct relative prefix from renderEntry to the module's assets
  // directory. Used to fix JSX template literal paths.
  const htmlDir = path.dirname(renderEntryPath);
  const moduleAssetsDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR);
  const correctAssetsPrefix = formatRelativeAssetRef(
    path.relative(htmlDir, moduleAssetsDir),
  );

  return content
    .replace(
      /\b(src|href|xlink:href)\s*=\s*(["'])(.*?)\2/gi,
      (_match, attr: string, quote: string, ref: string) =>
        `${attr}=${quote}${rewriteRefWithQuoteAwareness(ref)}${quote}`,
    )
    .replace(
      /url\(\s*(["']?)([^'")]+)\1\s*\)/gi,
      (_match, quote: string, ref: string) =>
        `url(${quote}${rewriteRef(ref)}${quote})`,
    )
    // Handle JSX/Vue template literal or expression patterns that hard-code
    // `./assets/` as a prefix before a dynamic expression. When sourceData
    // values get rewritten to full relative paths, this prefix becomes
    // redundant and produces a double-path at runtime.
    // Replace `./assets/` with the correct relative path from the merged
    // entry to the module's assets directory.
    .replace(
      /\b(src|href)\s*=\s*\{(`|'|")\.\/assets\//gi,
      (_match, attr: string, quote: string) =>
        `${attr}={${quote}${correctAssetsPrefix}/`,
    );
};

/**
 * Rewrite asset references inside a parsed JSON value (e.g. source-data.json).
 *
 * Unlike {@link rewriteModuleLocalAssetReferences} (which scans `src=`/`url()`
 * in HTML/CSS text), this walks structured JSON: every string value is treated
 * as a potential asset reference and rewritten to the correct path relative to
 * `renderEntryPath`. Matching is basename-based (plus the existing normalized
 * ref map) so it is robust to whatever base path the agent guessed —
 * `./assets/x.png`, `assets/x.png`, `../../../../assets/x.png` all resolve to
 * the same real asset. Non-asset strings are left untouched.
 */
const rewriteModuleLocalAssetReferencesInValue = ({
  allowedAssets,
  moduleDir,
  moduleLocalAssetRefs,
  renderEntryPath,
  value,
}: {
  allowedAssets?: ModuleOutputAllowedAsset[];
  moduleDir: string;
  moduleLocalAssetRefs?: string[];
  renderEntryPath: string;
  value: unknown;
}): unknown => {
  const declaredAssetMap = buildDeclaredAssetMap({
    allowedAssets,
    declaredAssetRefs: moduleLocalAssetRefs,
    moduleDir,
    renderEntryPath,
  });
  // Secondary index keyed by basename → resolved asset path. Lets us recover
  // the right asset even when the agent wrote an arbitrary relative prefix
  // (e.g. `../../../../assets/shape.png`).
  const basenameIndex = new Map<string, string>();
  for (const assetPath of declaredAssetMap.values()) {
    const base = path.basename(assetPath).toLowerCase();
    if (base && !basenameIndex.has(base)) basenameIndex.set(base, assetPath);
  }

  const htmlDir = path.dirname(renderEntryPath);
  const rewriteStringRef = (ref: string): string => {
    if (!ref || ref.startsWith("#")) return ref;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|data:)/i.test(ref)) return ref;
    if (!isSupportedModuleAssetPath(ref)) return ref;
    // 1) Exact / normalized match against declared refs.
    const direct = resolveDeclaredAssetRef({
      declaredAssetMap,
      renderEntryPath,
      ref,
    });
    if (direct) return direct;
    // 2) Basename fallback for arbitrary relative prefixes.
    // Skip bare filenames (no path separators / no ./ prefix): these are
    // likely used in JSX/Vue template literals that already prepend a
    // directory prefix (e.g. `./assets/${item.img}`). Rewriting them to full
    // paths causes double-prefix issues when the fragment also has a static
    // path prefix in the template literal.
    if (!ref.includes("/") && !ref.startsWith("./") && !ref.startsWith("../")) {
      return ref;
    }
    const base = path.basename(ref.split(/[?#]/)[0] ?? ref).toLowerCase();
    const matchedAsset = base ? basenameIndex.get(base) : undefined;
    if (matchedAsset) {
      return formatRelativeAssetRef(
        path.relative(htmlDir, matchedAsset),
      );
    }
    return ref;
  };

  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return rewriteStringRef(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = visit(v);
      return out;
    }
    return node;
  };
  return visit(value);
};

const renderSingleModuleCss = (module: ModuleMergeResolvedModule) => {
  const scopeSelector = `[data-module-id="${module.id}"]`;
  const scopedCss = scopeCss(
    module.moduleCss,
    scopeSelector,
    `${module.id}-`,
  ).replace(
    new RegExp(
      `(${escapeRegExp(scopeSelector)})\\s+\\.${escapeRegExp(module.id)}(?=$|[\\s.#:[>{,+~])`,
      "g",
    ),
    "$1",
  );
  return [
    `/* ${module.id}: ${path.relative(process.cwd(), module.moduleCssPath).replaceAll(path.sep, "/")} */`,
    scopedCss.trim(),
    "",
  ];
};

const renderSingleModuleFastCss = (module: ModuleMergeResolvedModule) =>
  [
    "/* Generated by deterministic single-module merge. */",
    ".design-module {",
    "  position: absolute;",
    "  overflow: hidden;",
    "  z-index: 10;",
    "}",
    "",
    ".shared-design-layer {",
    "  position: absolute;",
    "  overflow: hidden;",
    "  pointer-events: none;",
    "  user-select: none;",
    "}",
    "",
    '.shared-design-layer[data-shared-layer-kind="shared-underlay"] {',
    "  z-index: 0;",
    "}",
    "",
    '.shared-design-layer[data-shared-layer-kind="shared-overlay"] {',
    "  z-index: 20;",
    "}",
    "",
    ".shared-design-layer__asset {",
    "  display: block;",
    "  width: 100%;",
    "  height: 100%;",
    "}",
    "",
    ".design-module,",
    ".shared-design-layer,",
    ".shared-design-layer *,",
    ".design-module * {",
    "  box-sizing: border-box;",
    "}",
    "",
    `/* ${module.id}: ${path.relative(process.cwd(), module.moduleCssPath).replaceAll(path.sep, "/")} */`,
    module.moduleCss.trim(),
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd();

const renderModuleCss = (modules: ModuleMergeResolvedModule[]) =>
  [
    "/* Generated by deterministic module merge. */",
    ".design-module {",
    "  position: absolute;",
    "  overflow: hidden;",
    "  z-index: 10;",
    "}",
    "",
    ".shared-design-layer {",
    "  position: absolute;",
    "  overflow: hidden;",
    "  pointer-events: none;",
    "  user-select: none;",
    "}",
    "",
    '.shared-design-layer[data-shared-layer-kind="shared-underlay"] {',
    "  z-index: 0;",
    "}",
    "",
    '.shared-design-layer[data-shared-layer-kind="shared-overlay"] {',
    "  z-index: 20;",
    "}",
    "",
    ".shared-design-layer__asset {",
    "  display: block;",
    "  width: 100%;",
    "  height: 100%;",
    "}",
    "",
    ".design-module,",
    ".shared-design-layer,",
    ".shared-design-layer *,",
    ".design-module * {",
    "  box-sizing: border-box;",
    "}",
    "",
    ...modules.flatMap(renderSingleModuleCss),
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trimEnd();

const injectModuleCss = ({ css, html }: { css: string; html: string }) => {
  const block = `${MODULE_CSS_STYLE_START}\n${indent(css, 6)}\n    ${MODULE_CSS_STYLE_END}`;
  const existingPattern = new RegExp(
    `${MODULE_CSS_STYLE_START}[\\s\\S]*?${MODULE_CSS_STYLE_END}`,
    "m",
  );

  if (existingPattern.test(html)) return html.replace(existingPattern, block);
  if (!html.includes("</head>")) {
    throw new Error("Unable to locate </head> in scaffold HTML");
  }

  return html.replace("</head>", `    ${block}\n  </head>`);
};

const renderModuleSections = (modules: ModuleMergeResolvedModule[]) =>
  modules
    .map((module) =>
      [
        `<section class="design-module ${module.id}" data-module-id="${module.id}" style="${formatRegionStyle(module.region)}">`,
        indent(module.previewFragmentHtml, 8),
        "      </section>",
      ].join("\n"),
    )
    .join("\n      ");

const formatRegionJsxStyle = (region: ModuleMergeResolvedModule["region"]) =>
  `{{ position: "absolute", left: "${formatPx(region.x)}", top: "${formatPx(region.y)}", width: "${formatPx(region.width)}", height: "${formatPx(region.height)}", overflow: "hidden" }}`;

const stripMarkdownCodeFence = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
};

const extractParenthesizedReturn = (source: string) => {
  const match = /\breturn\s*\(/.exec(source);
  if (!match) return null;

  const start = match.index + match[0].length;
  let depth = 1;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index).trim();
  }

  return null;
};

const normalizeReactSourceFragment = (sourceFragment: string) => {
  let source = stripMarkdownCodeFence(sourceFragment);
  const returned = extractParenthesizedReturn(source);
  if (returned) return returned;
  source = source.replace(/^\s*import\b[\s\S]*?;?\s*$/gm, "").trim();
  const exportDefault = source.match(/^\s*export\s+default\s+([\s\S]*?);?\s*$/);
  return (exportDefault?.[1] ?? source).trim();
};

const normalizeVueSourceFragment = (sourceFragment: string) => {
  let source = stripMarkdownCodeFence(sourceFragment);
  // Only strip an outer SFC `<template>` wrapper when the input is a full SFC
  // (starts with `<template` and contains a `<script>`/`<style>` block). A bare
  // fragment body may legitimately contain inner `<template v-if>`/`<template
  // #slot>` tags; the old unconditional greedy match paired those inner tags
  // and discarded everything outside them.
  const looksLikeSingleFileComponent =
    /^\s*<template\b/i.test(source) &&
    /<\/template>\s*(?:<script\b|<style\b)/i.test(source);
  if (looksLikeSingleFileComponent) {
    const templateMatch = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
    if (templateMatch?.[1]) source = templateMatch[1];
  }
  source = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return source.trim();
};

const normalizeSourceFragment = (
  sourceFragment: string,
  format: "vue" | "react",
) =>
  format === "react"
    ? normalizeReactSourceFragment(sourceFragment)
    : normalizeVueSourceFragment(sourceFragment);

const renderModuleSourceSections = (
  modules: ModuleMergeResolvedModule[],
  format: "vue" | "react",
) =>
  modules
    .map((module) => {
      const sourceFragment = module.sourceFragment
        ? normalizeSourceFragment(module.sourceFragment, format)
        : "";
      if (!sourceFragment) {
        throw new Error(
          `${module.id} is missing ${format === "vue" ? "source.fragment.vue.html" : "source.fragment.jsx"} for ${format} source merge`,
        );
      }
      if (format === "react") {
        return [
          `<section className="design-module ${module.id}" data-module-id="${module.id}" style=${formatRegionJsxStyle(module.region)}>`,
          indent(sourceFragment, 8),
          "      </section>",
        ].join("\n");
      }
      return [
        `<section class="design-module ${module.id}" data-module-id="${module.id}" style="${formatRegionStyle(module.region)}">`,
        indent(sourceFragment, 8),
        "      </section>",
      ].join("\n");
    })
    .join("\n      ");

type ResolvedSharedLayer = ModulePlanSharedLayer & {
  htmlRef: string;
  region: NonNullable<ModulePlanSharedLayer["region"]>;
};

const renderSharedLayerSections = (
  layers: ResolvedSharedLayer[],
  kind: ModulePlanSharedLayer["kind"],
) =>
  layers
    .filter((layer) => layer.kind === kind)
    .map((layer) =>
      [
        `<div class="shared-design-layer ${escapeHtmlAttribute(layer.id)}" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style="${formatRegionStyle(layer.region)}">`,
        `        <img class="shared-design-layer__asset" src="${escapeHtmlAttribute(layer.htmlRef)}" alt="" aria-hidden="true" />`,
        "      </div>",
      ].join("\n"),
    )
    .join("\n      ");

const renderSharedLayerSourceSections = (
  layers: ResolvedSharedLayer[],
  kind: ModulePlanSharedLayer["kind"],
  format: "vue" | "react",
) =>
  layers
    .filter((layer) => layer.kind === kind)
    .map((layer) => {
      if (format === "react") {
        return [
          `<div className="shared-design-layer ${escapeHtmlAttribute(layer.id)}" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style=${formatRegionJsxStyle(layer.region)}>`,
          `        <img className="shared-design-layer__asset" src=${JSON.stringify(layer.htmlRef)} alt="" aria-hidden="true" />`,
          "      </div>",
        ].join("\n");
      }
      return [
        `<div class="shared-design-layer ${escapeHtmlAttribute(layer.id)}" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style="${formatRegionStyle(layer.region)}">`,
        `        <img class="shared-design-layer__asset" src="${escapeHtmlAttribute(layer.htmlRef)}" alt="" aria-hidden="true" />`,
        "      </div>",
      ].join("\n");
    })
    .join("\n      ");

const replaceDesignPageContent = ({
  html,
  sections,
}: {
  html: string;
  sections: string;
}) => {
  const pattern =
    /(<main\b[^>]*class=(["'])[^"']*\bdesign-page\b[^"']*\2[^>]*>)([\s\S]*?)(<\/main>)/i;
  if (!pattern.test(html)) {
    throw new Error(
      'Unable to locate <main class="design-page"> in scaffold HTML',
    );
  }

  return html.replace(pattern, `$1\n      ${sections}\n    $4`);
};

export {
  injectModuleCss,
  renderModuleCss,
  renderModuleSections,
  renderModuleSourceSections,
  renderSharedLayerSections,
  renderSharedLayerSourceSections,
  renderSingleModuleFastCss,
  renderSingleModuleCss,
  rewriteModuleLocalAssetReferences,
  rewriteModuleLocalAssetReferencesInValue,
  normalizeSourceFragment,
  replaceDesignPageContent,
};
