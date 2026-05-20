import { existsSync } from 'node:fs'
import path from 'node:path'

import { safeDecodeUri } from '../../core/io.js'
import {
  MODULE_LOCAL_ASSET_DIR,
  isSupportedModuleAssetPath,
  type ModuleOutputAllowedAsset,
} from '../module-output-policy.js'
import type {
  ModuleMergeResolvedModule,
  ModulePlanSharedLayer,
} from './types.js'
import { scopeCss } from './css.js'
import { formatRegionStyle, indent } from './utils.js'

const MODULE_CSS_STYLE_START = '<style data-module-merge-generated>'
const MODULE_CSS_STYLE_END = '</style>'

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const splitAssetRef = (value: string) => {
  const decoded = safeDecodeUri(value.trim()).replace(/^file:\/\//, '')
  const suffixStart = decoded.search(/[?#]/)
  if (suffixStart === -1) return { pathPart: decoded, suffix: '' }
  return {
    pathPart: decoded.slice(0, suffixStart),
    suffix: decoded.slice(suffixStart),
  }
}

const normalizeSlashes = (value: string) => value.replaceAll('\\', '/')

const normalizePathKey = (value: string) =>
  normalizeSlashes(path.resolve(value)).toLowerCase()

const isPathInside = (candidate: string, parent: string) => {
  const normalizedCandidate = normalizePathKey(candidate)
  const normalizedParent = normalizePathKey(parent)
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  )
}

const getAllowedAssetPathValues = (asset: ModuleOutputAllowedAsset) =>
  [
    asset.svgPath,
    asset.pngPath,
    asset.webpPath,
    asset.jpgPath,
    asset.jpegPath,
    asset.avifPath,
    asset.assetPath,
    asset.path,
    asset.relativePath,
    asset.htmlRef,
    asset.sourcePath,
    asset.url,
  ].filter((value): value is string => typeof value === 'string')

const addAssetRefAliases = ({
  assetPath,
  map,
  moduleDir,
  outputHtmlPath,
  ref,
}: {
  assetPath: string
  map: Map<string, string>
  moduleDir: string
  outputHtmlPath: string
  ref: string
}) => {
  const htmlDir = path.dirname(outputHtmlPath)
  const aliases = [
    ref,
    assetPath,
    path.relative(moduleDir, assetPath),
    path.relative(htmlDir, assetPath),
    `./${path.relative(moduleDir, assetPath)}`,
    `./${path.relative(htmlDir, assetPath)}`,
  ]

  for (const alias of aliases) {
    map.set(normalizePathKey(alias), assetPath)
    map.set(normalizeSlashes(alias).replace(/^\.\//, '').toLowerCase(), assetPath)
  }
}

const addDeclaredAssetRefToMap = ({
  map,
  moduleDir,
  outputHtmlPath,
  ref,
}: {
  map: Map<string, string>
  moduleDir: string
  outputHtmlPath: string
  ref: string
}) => {
  const assetPath = resolveDeclaredAssetPath({
    moduleDir,
    outputHtmlPath,
    ref,
  })
  if (!assetPath) return
  addAssetRefAliases({
    assetPath,
    map,
    moduleDir,
    outputHtmlPath,
    ref,
  })
}

const resolveDeclaredAssetPath = ({
  moduleDir,
  outputHtmlPath,
  ref,
}: {
  moduleDir: string
  outputHtmlPath: string
  ref: string
}) => {
  const { pathPart: cleaned } = splitAssetRef(ref)
  if (
    !cleaned ||
    cleaned.startsWith('#') ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned) ||
    !isSupportedModuleAssetPath(cleaned)
  ) {
    return null
  }

  const htmlDir = path.dirname(outputHtmlPath)
  const assetDir = path.join(moduleDir, MODULE_LOCAL_ASSET_DIR)
  const candidates = path.isAbsolute(cleaned)
    ? [path.resolve(cleaned)]
    : [
        path.resolve(moduleDir, cleaned),
        path.resolve(htmlDir, cleaned),
        path.resolve(process.cwd(), cleaned),
      ]
  return (
    candidates.find(
      (candidate) =>
        existsSync(candidate) &&
        (isPathInside(candidate, assetDir) || !isPathInside(candidate, moduleDir)),
    ) ?? null
  )
}

const buildDeclaredAssetMap = ({
  allowedAssets,
  declaredAssetRefs,
  moduleDir,
  outputHtmlPath,
}: {
  allowedAssets?: ModuleOutputAllowedAsset[]
  declaredAssetRefs?: string[]
  moduleDir: string
  outputHtmlPath: string
}) => {
  const map = new Map<string, string>()
  for (const ref of declaredAssetRefs ?? []) {
    addDeclaredAssetRefToMap({
      map,
      moduleDir,
      outputHtmlPath,
      ref,
    })
  }
  for (const asset of allowedAssets ?? []) {
    const refs = getAllowedAssetPathValues(asset)
    const assetPath =
      refs
        .map((ref) =>
          resolveDeclaredAssetPath({ moduleDir, outputHtmlPath, ref }),
        )
        .find((value): value is string => Boolean(value)) ?? null
    if (!assetPath) continue
    for (const ref of refs) {
      addAssetRefAliases({
        assetPath,
        map,
        moduleDir,
        outputHtmlPath,
        ref,
      })
    }
  }
  return map
}

const resolveDeclaredAssetRef = ({
  declaredAssetMap,
  outputHtmlPath,
  ref,
}: {
  declaredAssetMap: Map<string, string>
  outputHtmlPath: string
  ref: string
}) => {
  const { pathPart, suffix } = splitAssetRef(ref)
  const assetPath =
    declaredAssetMap.get(normalizePathKey(pathPart)) ??
    declaredAssetMap.get(normalizeSlashes(pathPart).replace(/^\.\//, '').toLowerCase())
  if (!assetPath) return null
  return `${normalizeSlashes(path.relative(path.dirname(outputHtmlPath), assetPath))}${suffix}`
}

const rewriteModuleLocalAssetReferences = ({
  allowedAssets,
  content,
  moduleDir,
  moduleLocalAssetRefs,
  outputHtmlPath,
}: {
  allowedAssets?: ModuleOutputAllowedAsset[]
  content: string
  moduleDir: string
  moduleLocalAssetRefs?: string[]
  outputHtmlPath: string
}) => {
  const declaredAssetMap = buildDeclaredAssetMap({
    allowedAssets,
    declaredAssetRefs: moduleLocalAssetRefs,
    moduleDir,
    outputHtmlPath,
  })
  const rewriteRef = (ref: string) =>
    resolveDeclaredAssetRef({
      declaredAssetMap,
      outputHtmlPath,
      ref,
    }) ?? ref

  return content
    .replace(
      /\b(src|href|xlink:href)\s*=\s*(["'])(.*?)\2/gi,
      (_match, attr: string, quote: string, ref: string) =>
        `${attr}=${quote}${rewriteRef(ref)}${quote}`,
    )
    .replace(
      /url\(\s*(["']?)([^'")]+)\1\s*\)/gi,
      (_match, quote: string, ref: string) =>
        `url(${quote}${rewriteRef(ref)}${quote})`,
    )
}

const renderSingleModuleCss = (module: ModuleMergeResolvedModule) => {
  const scopeSelector = `[data-module-id="${module.id}"]`
  const scopedCss = scopeCss(
    module.fragmentCss,
    scopeSelector,
    `${module.id}-`,
  ).replace(
    new RegExp(
      `(${escapeRegExp(scopeSelector)})\\s+\\.${escapeRegExp(module.id)}(?=$|[\\s.#:[>{,+~])`,
      'g',
    ),
    '$1',
  )
  return [
    `/* ${module.id}: ${path.relative(process.cwd(), module.cssPath).replaceAll(path.sep, '/')} */`,
    scopedCss.trim(),
    '',
  ]
}

const renderSingleModuleFastCss = (module: ModuleMergeResolvedModule) =>
  [
    '/* Generated by deterministic single-module merge. */',
    '.design-module {',
    '  position: absolute;',
    '  overflow: hidden;',
    '  z-index: 10;',
    '}',
    '',
    '.shared-design-layer {',
    '  position: absolute;',
    '  overflow: hidden;',
    '  pointer-events: none;',
    '  user-select: none;',
    '}',
    '',
    '.shared-design-layer[data-shared-layer-kind="shared-underlay"] {',
    '  z-index: 0;',
    '}',
    '',
    '.shared-design-layer[data-shared-layer-kind="shared-overlay"] {',
    '  z-index: 20;',
    '}',
    '',
    '.shared-design-layer__asset {',
    '  display: block;',
    '  width: 100%;',
    '  height: 100%;',
    '}',
    '',
    '.design-module,',
    '.shared-design-layer,',
    '.shared-design-layer *,',
    '.design-module * {',
      '  box-sizing: border-box;',
    '}',
    '',
    `/* ${module.id}: ${path.relative(process.cwd(), module.cssPath).replaceAll(path.sep, '/')} */`,
    module.fragmentCss.trim(),
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .trimEnd()

const renderModuleCss = (modules: ModuleMergeResolvedModule[]) =>
  [
    '/* Generated by deterministic module merge. */',
    '.design-module {',
    '  position: absolute;',
    '  overflow: hidden;',
    '  z-index: 10;',
    '}',
    '',
    '.shared-design-layer {',
    '  position: absolute;',
    '  overflow: hidden;',
    '  pointer-events: none;',
    '  user-select: none;',
    '}',
    '',
    '.shared-design-layer[data-shared-layer-kind="shared-underlay"] {',
    '  z-index: 0;',
    '}',
    '',
    '.shared-design-layer[data-shared-layer-kind="shared-overlay"] {',
    '  z-index: 20;',
    '}',
    '',
    '.shared-design-layer__asset {',
    '  display: block;',
    '  width: 100%;',
    '  height: 100%;',
    '}',
    '',
    '.design-module,',
    '.shared-design-layer,',
    '.shared-design-layer *,',
    '.design-module * {',
    '  box-sizing: border-box;',
    '}',
    '',
    ...modules.flatMap(renderSingleModuleCss),
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .trimEnd()

const injectModuleCss = ({ css, html }: { css: string; html: string }) => {
  const block = `${MODULE_CSS_STYLE_START}\n${indent(css, 6)}\n    ${MODULE_CSS_STYLE_END}`
  const existingPattern = new RegExp(
    `${MODULE_CSS_STYLE_START}[\\s\\S]*?${MODULE_CSS_STYLE_END}`,
    'm',
  )

  if (existingPattern.test(html)) return html.replace(existingPattern, block)
  if (!html.includes('</head>')) {
    throw new Error('Unable to locate </head> in scaffold HTML')
  }

  return html.replace('</head>', `    ${block}\n  </head>`)
}

const renderModuleSections = (modules: ModuleMergeResolvedModule[]) =>
  modules
    .map((module) =>
      [
        `<section class="design-module ${module.id}" data-module-id="${module.id}" style="${formatRegionStyle(module.region)}">`,
        indent(module.fragmentHtml, 8),
        '      </section>',
      ].join('\n'),
    )
    .join('\n      ')

type ResolvedSharedLayer = ModulePlanSharedLayer & {
  htmlRef: string
  region: NonNullable<ModulePlanSharedLayer['region']>
}

const renderSharedLayerSections = (
  layers: ResolvedSharedLayer[],
  kind: ModulePlanSharedLayer['kind'],
) =>
  layers
    .filter((layer) => layer.kind === kind)
    .map((layer) =>
      [
        `<div class="shared-design-layer ${escapeHtmlAttribute(layer.id)}" data-shared-layer-id="${escapeHtmlAttribute(layer.id)}" data-shared-layer-kind="${layer.kind}" style="${formatRegionStyle(layer.region)}">`,
        `        <img class="shared-design-layer__asset" src="${escapeHtmlAttribute(layer.htmlRef)}" alt="" aria-hidden="true" />`,
        '      </div>',
      ].join('\n'),
    )
    .join('\n      ')

const replaceDesignPageContent = ({
  html,
  sections,
}: {
  html: string
  sections: string
}) => {
  const pattern =
    /(<main\b[^>]*class=(["'])[^"']*\bdesign-page\b[^"']*\2[^>]*>)([\s\S]*?)(<\/main>)/i
  if (!pattern.test(html)) {
    throw new Error(
      'Unable to locate <main class="design-page"> in scaffold HTML',
    )
  }

  return html.replace(pattern, `$1\n      ${sections}\n    $4`)
}

export {
  injectModuleCss,
  renderModuleCss,
  renderModuleSections,
  renderSharedLayerSections,
  renderSingleModuleFastCss,
  renderSingleModuleCss,
  rewriteModuleLocalAssetReferences,
  replaceDesignPageContent,
}
