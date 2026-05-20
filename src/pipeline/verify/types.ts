import type { RegionStat } from '../../core/diff.js'
import type { ModuleDomReconcileReport } from '../../core/module-dom-reconcile.js'
import type { Region } from '../../core/utils.js'

type ModuleRegionStat = RegionStat & {
  region: Region
}

type ModuleRegionSummary = {
  activeModules: number
  topModules: ModuleRegionStat[]
  totalModules: number
}

type VerifyResult = {
  artifactDir: string
  diffPngPath: string
  diffRatio: number
  htmlImageErrors?: Array<{
    alt: string
    currentSrc: string
    naturalHeight: number
    naturalWidth: number
    src: string
  }>
  htmlImageIntegrityPassed?: boolean
  sourceImageErrors?: Array<{
    alt: string
    currentSrc: string
    naturalHeight: number
    naturalWidth: number
    src: string
  }>
  sourceImageIntegrityPassed?: boolean
  sourceRenderMode?: 'svg-image' | 'html'
  htmlPngPath: string
  layoutBoxPassed: boolean
  mode?: VerifyMode
  svgPngPath: string
  textBoxReportPath?: string
  layoutBoxReportPath?: string
  textInsightsPath?: string
  textContentPriorityIssueCount?: number
  textGeometryPriorityIssueCount?: number
  textPriorityIssueCount?: number
  workflowLintPassed: boolean
  workflowLintPath?: string
  finalOutputPolicyPassed?: boolean
  finalOutputPolicyPath?: string
  verifyReportPath: string
  ocrProvider?: string
  fontRenderingLimitLikely?: boolean
  fontRenderingLimitReason?: string
  regionsPath?: string
  regionStats?: RegionStat[]
  moduleRegionStats?: ModuleRegionStat[]
  moduleRegionSummary?: ModuleRegionSummary
  moduleRegionDiffFailures?: ModuleRegionStat[]
  moduleRegionDiffPassed?: boolean
  moduleRegionDiffThreshold?: number
  moduleDomReconcilePath?: string
  moduleDomReconcileMarkdownPath?: string
  moduleDomReconcileSummary?: ModuleDomReconcileReport
}

type VerifyMode = 'full' | 'fast'

type VerifyOptions = {
  htmlPath?: string
  mode?: VerifyMode
  reuseCachedOcr?: boolean
  runFinalOutputPolicy?: boolean
  scale?: number
  sourceHtmlPath?: string
}

export type { ModuleRegionStat, ModuleRegionSummary, VerifyMode, VerifyOptions, VerifyResult }
