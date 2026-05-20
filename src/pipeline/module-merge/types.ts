import type { TextLayoutConfig } from '../../core/text-layout.js'
import type { Region } from '../../core/utils.js'

type ModuleTextLayoutCoordinateSpace = 'absolute' | 'local'

type ModulePlanModule = {
  dir?: string
  id: string
  region?: Region
  textLayoutCoordinateSpace?: ModuleTextLayoutCoordinateSpace
  [key: string]: unknown
}

type ModulePlanSharedLayer = {
  id: string
  kind: 'shared-underlay' | 'shared-overlay'
  region?: Region
  relativePath?: string
  svgPath?: string
  [key: string]: unknown
}

type ModulePlan = {
  baseHtmlPath?: string
  design?: {
    height?: number
    name?: string
    svgPath?: string
    width?: number
  }
  finalHtmlPath?: string
  htmlPath?: string
  modules?: ModulePlanModule[] | Record<string, Omit<ModulePlanModule, 'id'>>
  outputHtmlPath?: string
  scaffoldHtmlPath?: string
  sharedLayers?: ModulePlanSharedLayer[]
  textLayoutCoordinateSpace?: ModuleTextLayoutCoordinateSpace
  [key: string]: unknown
}

type ModuleFragmentManifest = {
  id?: string
  moduleId?: string
  region?: Region
  textLayoutCoordinateSpace?: ModuleTextLayoutCoordinateSpace
  [key: string]: unknown
}

type ModuleMergeOptions = {
  artifactDir?: string
  modulePlanPath?: string
  modulesDir?: string
  outputHtmlPath?: string
  skipInvalidModules?: boolean
  scaffoldHtmlPath?: string
}

type ModuleMergeSkippedModule = {
  error: string
  id: string
}

type ModuleMergeResolvedModule = {
  cssPath: string
  dir: string
  fragmentCss: string
  fragmentHtml: string
  htmlPath: string
  id: string
  manifest: ModuleFragmentManifest
  manifestPath: string
  planEntry: ModulePlanModule
  region: Region
  textLayout: TextLayoutConfig
  textLayoutCoordinateSpace: ModuleTextLayoutCoordinateSpace
  textLayoutPath: string
}

type ModuleMergeResult = {
  moduleCount: number
  moduleIds: string[]
  modulePlanPath: string
  modulesDir: string
  outputHtmlPath: string
  scaffoldHtmlPath: string
  skippedModuleIds: string[]
  skippedModules: ModuleMergeSkippedModule[]
  textLayoutBlockCount: number
  textLayoutMissingSelectorCount: number
  textLayoutMissingSelectors: Array<{
    blockId: string
    selectors: string[]
  }>
  textLayoutRuleCount: number
  textLayoutSelectorCheckPassed: boolean
}

export type {
  ModuleFragmentManifest,
  ModuleMergeOptions,
  ModuleMergeResolvedModule,
  ModuleMergeResult,
  ModuleMergeSkippedModule,
  ModulePlan,
  ModulePlanModule,
  ModulePlanSharedLayer,
  ModuleTextLayoutCoordinateSpace,
}
