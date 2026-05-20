import path from 'node:path'

import {
  injectInlineConfig,
  injectInlineStyle,
  renderTextLayoutCss,
} from '../../core/text-layout.js'
import type { TextLayoutConfig } from '../../core/text-layout.js'
import { writeTextFile } from '../../core/utils.js'
import { readSvgPageBackgroundPaint } from '../../core/svg-vertical-modules/module-svg-crop.js'
import type {
  ModuleMergeOptions,
  ModuleMergeResult,
  ModulePlanSharedLayer,
} from './types.js'
import {
  injectModuleCss,
  renderModuleCss,
  renderModuleSections,
  renderSharedLayerSections,
  renderSingleModuleFastCss,
  renderSingleModuleCss,
  replaceDesignPageContent,
} from './html-render.js'
import {
  assertUniqueModuleIds,
  loadResolvedModule,
  normalizePlanModules,
  readModulePlan,
} from './module-loader.js'
import {
  resolveModulePlanPath,
  resolveOutputHtmlPath,
  resolveScaffoldHtmlPath,
} from './paths.js'
import { mergeTextLayoutConfig } from './text-layout.js'
import { readRequiredText, resolveConfiguredPath } from './utils.js'

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const htmlContainsId = (html: string, id: string) =>
  new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, 'i').test(html)

const htmlContainsClass = (html: string, className: string) => {
  for (const match of html.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)) {
    if ((match[1] ?? '').split(/\s+/).includes(className)) return true
  }
  return false
}

const singleSelectorLikelyMatchesHtml = ({
  html,
  selector,
}: {
  html: string
  selector: string
}) => {
  const idMatch =
    selector.match(/#([A-Za-z_][\w-]*)/) ??
    selector.match(/\[id\s*=\s*["']([^"']+)["']\]/i)
  if (idMatch?.[1]) return htmlContainsId(html, idMatch[1])

  const classNames = [...selector.matchAll(/\.([A-Za-z_-][\w-]*)/g)].map(
    (match) => match[1],
  )
  if (classNames.length) {
    return classNames.every(
      (className) => className && htmlContainsClass(html, className),
    )
  }

  return true
}

const selectorLikelyMatchesHtml = ({
  html,
  selector,
}: {
  html: string
  selector: string
}) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => singleSelectorLikelyMatchesHtml({ html, selector: part }))

const findMissingTextLayoutSelectors = ({
  config,
  html,
}: {
  config: ReturnType<typeof mergeTextLayoutConfig>
  html: string
}) =>
  (config.blocks ?? []).flatMap((block) => {
    const selectors = block.selectors ?? []
    if (
      selectors.length &&
      selectors.some((selector) =>
        selectorLikelyMatchesHtml({ html, selector }),
      )
    ) {
      return []
    }
    return [
      {
        blockId: block.id,
        selectors,
      },
    ]
  })

const normalizeSharedLayers = ({
  modulePlan,
  outputHtmlPath,
  planDir,
}: {
  modulePlan: Awaited<ReturnType<typeof readModulePlan>>
  outputHtmlPath: string
  planDir: string
}) =>
  (Array.isArray(modulePlan.sharedLayers) ? modulePlan.sharedLayers : [])
    .filter(
      (layer): layer is ModulePlanSharedLayer =>
        Boolean(
          layer &&
            typeof layer.id === 'string' &&
            (layer.kind === 'shared-underlay' ||
              layer.kind === 'shared-overlay') &&
            layer.region,
        ),
    )
    .flatMap((layer) => {
      const sourceRef =
        typeof layer.svgPath === 'string'
          ? layer.svgPath
          : typeof layer.relativePath === 'string'
            ? layer.relativePath
            : undefined
      if (!sourceRef) return []
      const assetPath = resolveConfiguredPath(sourceRef, planDir)
      const htmlRef = `./${path
        .relative(path.dirname(outputHtmlPath), assetPath)
        .replaceAll(path.sep, '/')}`
      return [
        {
          ...layer,
          htmlRef,
          region: layer.region!,
        },
      ]
    })

const mergeModulesIntoHtml = async (
  options: ModuleMergeOptions,
): Promise<ModuleMergeResult> => {
  const modulePlanPath = resolveModulePlanPath(options)
  const planDir = path.dirname(modulePlanPath)
  const modulesDir = options.modulesDir
    ? resolveConfiguredPath(options.modulesDir, planDir)
    : path.dirname(modulePlanPath)
  const modulePlan = await readModulePlan(modulePlanPath)
  const outputHtmlPath = resolveOutputHtmlPath({
    modulePlan,
    outputHtmlPath: options.outputHtmlPath,
    planDir,
  })
  const scaffoldHtmlPath = resolveScaffoldHtmlPath({
    modulePlan,
    outputHtmlPath,
    planDir,
    scaffoldHtmlPath: options.scaffoldHtmlPath,
  })
  const planModules = await normalizePlanModules({ modulePlan, modulesDir })
  assertUniqueModuleIds(planModules)

  const loadResults = await Promise.all(
    planModules.map(async (planEntry) => {
      try {
        return {
          module: await loadResolvedModule({
            modulePlan,
            modulesDir,
            outputHtmlPath,
            planDir,
            planEntry,
          }),
        }
      } catch (error) {
        if (!options.skipInvalidModules) throw error
        return {
          skipped: {
            error: error instanceof Error ? error.message : String(error),
            id: planEntry.id,
          },
        }
      }
    }),
  )
  const loadedModules = loadResults.flatMap((result) =>
    result.module ? [result.module] : [],
  )
  const skippedModules = loadResults.flatMap((result) =>
    result.skipped ? [result.skipped] : [],
  )
  const modules = loadedModules.flatMap((module) => {
    try {
      renderSingleModuleCss(module)
      return [module]
    } catch (error) {
      if (!options.skipInvalidModules) throw error
      skippedModules.push({
        error: `${module.id}: module CSS could not be scoped for deterministic merge: ${error instanceof Error ? error.message : String(error)}`,
        id: module.id,
      })
      return []
    }
  })
  const scaffoldHtml = await readRequiredText(
    scaffoldHtmlPath,
    'scaffold/base HTML',
  )
  const baseConfig: TextLayoutConfig = { blocks: [], rules: [] }
  const mergedConfig = mergeTextLayoutConfig({ baseConfig, modules })
  const pageBackgroundPaint =
    typeof modulePlan.design?.svgPath === 'string'
      ? await readSvgPageBackgroundPaint(
          resolveConfiguredPath(modulePlan.design.svgPath, planDir),
        ).catch(() => undefined)
      : undefined
  const moduleCss =
    modules.length === 1
      ? renderSingleModuleFastCss(modules[0]!)
      : renderModuleCss(modules)
  const mergedCss = pageBackgroundPaint
    ? [
        `/* Page background inferred from leading full-viewport SVG background. */`,
        `.design-page {`,
        `  background: ${pageBackgroundPaint};`,
        `}`,
        '',
        moduleCss,
      ].join('\n')
    : moduleCss
  const sharedLayers = normalizeSharedLayers({
    modulePlan,
    outputHtmlPath,
    planDir,
  })
  const sections = [
    renderSharedLayerSections(sharedLayers, 'shared-underlay'),
    renderModuleSections(modules),
    renderSharedLayerSections(sharedLayers, 'shared-overlay'),
  ]
    .filter((section) => section.trim())
    .join('\n      ')

  const nextHtml = injectInlineStyle({
    css: renderTextLayoutCss(mergedConfig),
    html: injectInlineConfig({
      config: mergedConfig,
      html: injectModuleCss({
        css: mergedCss,
        html: replaceDesignPageContent({ html: scaffoldHtml, sections }),
      }),
    }),
  })
  const missingTextLayoutSelectors = findMissingTextLayoutSelectors({
    config: mergedConfig,
    html: nextHtml,
  })

  await writeTextFile(outputHtmlPath, nextHtml)

  return {
    moduleCount: modules.length,
    moduleIds: modules.map((module) => module.id),
    modulePlanPath,
    modulesDir,
    outputHtmlPath,
    scaffoldHtmlPath,
    skippedModuleIds: skippedModules.map((module) => module.id),
    skippedModules,
    textLayoutBlockCount: mergedConfig.blocks?.length ?? 0,
    textLayoutMissingSelectorCount: missingTextLayoutSelectors.length,
    textLayoutMissingSelectors: missingTextLayoutSelectors.slice(0, 50),
    textLayoutRuleCount: mergedConfig.rules.length,
    textLayoutSelectorCheckPassed: missingTextLayoutSelectors.length === 0,
  }
}

export { mergeModulesIntoHtml }
