import path from 'node:path'

import { MODULE_DIFF_RATIO_THRESHOLD } from '../../config/runtime.js'
import type { RegionStat } from '../../core/diff.js'
import type { ModuleDomReconcileReport } from '../../core/module-dom-reconcile.js'
import { writeJsonFile, writeTextFile } from '../../core/utils.js'
import { formatModuleRegionStat, sortModuleRegionStats } from './module-regions.js'
import type { ModuleRegionStat, ModuleRegionSummary } from './types.js'

type VerifyReportOptions = {
  agentHints: Array<{ kind: string; priority: number; summary: string }>
  artifactDir: string
  clusters: number
  diffPixels: number
  diffPngPath: string
  diffRatio: number
  finalOutputPolicyPassed: boolean
  finalOutputPolicyPath?: string
  fontRenderingLimitLikely?: boolean
  fontRenderingLimitReason?: string
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
  htmlOcrPath: string
  htmlPngPath: string
  layoutBoxPassed: boolean
  layoutBoxReportPath?: string
  moduleDomReconcileMarkdownPath?: string
  moduleDomReconcilePath?: string
  moduleDomReconcileSummary?: ModuleDomReconcileReport
  moduleRegionDiffFailures: ModuleRegionStat[]
  moduleRegionDiffPassed: boolean
  moduleRegionStats: ModuleRegionStat[]
  moduleRegionSummary: ModuleRegionSummary
  ocrProvider: string
  regionStats: RegionStat[]
  regionsPath?: string
  svgOcrPath: string
  svgPngPath: string
  textBoxReportPath?: string
  textContentPriorityIssueCount?: number
  textGeometryPriorityIssueCount?: number
  textPriorityIssueCount?: number
  textInsightsPath?: string
  totalPixels: number
  workflowLintPassed: boolean
  workflowLintPath?: string
}

const writeVerifyReport = async ({
  agentHints,
  artifactDir,
  clusters,
  diffPixels,
  diffPngPath,
  diffRatio,
  finalOutputPolicyPassed,
  finalOutputPolicyPath,
  fontRenderingLimitLikely,
  fontRenderingLimitReason,
  htmlImageErrors = [],
  htmlImageIntegrityPassed = htmlImageErrors.length === 0,
  sourceImageErrors = [],
  sourceImageIntegrityPassed = sourceImageErrors.length === 0,
  sourceRenderMode = 'svg-image',
  htmlOcrPath,
  htmlPngPath,
  layoutBoxPassed,
  layoutBoxReportPath,
  moduleDomReconcileMarkdownPath,
  moduleDomReconcilePath,
  moduleDomReconcileSummary,
  moduleRegionDiffFailures,
  moduleRegionDiffPassed,
  moduleRegionStats,
  moduleRegionSummary,
  ocrProvider,
  regionStats,
  regionsPath,
  svgOcrPath,
  svgPngPath,
  textBoxReportPath,
  textContentPriorityIssueCount = 0,
  textGeometryPriorityIssueCount = 0,
  textPriorityIssueCount = textContentPriorityIssueCount +
    textGeometryPriorityIssueCount,
  textInsightsPath,
  totalPixels,
  workflowLintPassed,
  workflowLintPath,
}: VerifyReportOptions) => {
  const verifyReportPath = path.join(artifactDir, 'verify-report.json')
  const verifyMarkdownPath = path.join(artifactDir, 'verify-report.md')

  const verifyReport = {
    diffRatio,
    diffPixels,
    totalPixels,
    clusters,
    layoutBoxPassed,
    workflowLintPassed,
    htmlImageIntegrityPassed,
    htmlImageErrors,
    sourceImageIntegrityPassed,
    sourceImageErrors,
    sourceRenderMode,
    finalOutputPolicyPassed,
    fontRenderingLimitLikely,
    fontRenderingLimitReason,
    ...(regionsPath
      ? {
          moduleRegionDiffFailures,
          moduleRegionDiffPassed,
          moduleRegionDiffThreshold: MODULE_DIFF_RATIO_THRESHOLD,
        }
      : {}),
    svgPngPath,
    htmlPngPath,
    diffPngPath,
    svgOcrPath,
    htmlOcrPath,
    textBoxReportPath,
    textContentPriorityIssueCount,
    textGeometryPriorityIssueCount,
    textPriorityIssueCount,
    layoutBoxReportPath,
    workflowLintPath,
    finalOutputPolicyPath,
    moduleDomReconcilePath,
    moduleDomReconcileMarkdownPath,
    moduleDomReconcileSummary,
    textInsightsPath,
    ocrProvider,
    agentHints,
    ...(regionsPath
      ? {
          regionsPath,
          regionStats,
          moduleRegionStats,
          moduleRegionSummary,
        }
      : {}),
  }

  await writeJsonFile(verifyReportPath, verifyReport)

  const mdLines = [
    '# Verify Report',
    '',
    `- diffRatio: ${diffRatio}`,
    `- diffPixels: ${diffPixels}`,
    `- totalPixels: ${totalPixels}`,
    `- clusters: ${clusters}`,
    `- workflowLintPassed: ${workflowLintPassed}`,
    `- htmlImageIntegrityPassed: ${htmlImageIntegrityPassed}`,
    `- htmlImageErrorCount: ${htmlImageErrors.length}`,
    `- sourceRenderMode: ${sourceRenderMode}`,
    `- sourceImageIntegrityPassed: ${sourceImageIntegrityPassed}`,
    `- sourceImageErrorCount: ${sourceImageErrors.length}`,
    `- finalOutputPolicyPassed: ${finalOutputPolicyPassed}`,
    `- textContentPriorityIssueCount: ${textContentPriorityIssueCount}`,
    `- textGeometryPriorityIssueCount: ${textGeometryPriorityIssueCount}`,
    `- textPriorityIssueCount: ${textPriorityIssueCount}`,
    `- fontRenderingLimitLikely: ${Boolean(fontRenderingLimitLikely)}`,
    ...(fontRenderingLimitReason
      ? [`- fontRenderingLimitReason: ${fontRenderingLimitReason}`]
      : []),
    ...(regionsPath
      ? [
          `- regionsPath: ${regionsPath}`,
          `- moduleRegions: ${moduleRegionSummary.activeModules}/${moduleRegionSummary.totalModules} with diffs`,
          `- moduleRegionDiffPassed: ${moduleRegionDiffPassed}`,
          `- moduleRegionDiffThreshold: ${MODULE_DIFF_RATIO_THRESHOLD}`,
        ]
      : []),
    '',
    '## Artifacts',
    `- SVG PNG: ${svgPngPath}`,
    `- HTML PNG: ${htmlPngPath}`,
    `- Diff PNG: ${diffPngPath}`,
    textBoxReportPath ? `- Text Box Report: ${textBoxReportPath}` : '- Text Box Report: skipped',
    layoutBoxReportPath ? `- Layout Box Report: ${layoutBoxReportPath}` : '- Layout Box Report: skipped',
    workflowLintPath ? `- Workflow Lint: ${workflowLintPath}` : '- Workflow Lint: skipped',
    finalOutputPolicyPath ? `- Final Output Policy: ${finalOutputPolicyPath}` : '- Final Output Policy: skipped',
    moduleDomReconcileMarkdownPath ? `- Module DOM Reconcile: ${moduleDomReconcileMarkdownPath}` : '- Module DOM Reconcile: skipped',
    textInsightsPath ? `- Text Insights: ${textInsightsPath}` : '- Text Insights: skipped',
    `- OCR Provider: ${ocrProvider}`,
    '',
  ]

  if (agentHints.length) {
    mdLines.push(
      '## Agent Hints',
      ...agentHints.map(
        (hint: { kind: string; priority: number; summary: string }) =>
          `- [${hint.kind}] (p${hint.priority}) ${hint.summary}`,
      ),
      '',
    )
  }

  if (htmlImageErrors.length) {
    mdLines.push(
      '## HTML Image Errors',
      '',
      ...htmlImageErrors.map(
        (issue) =>
          `- src=${issue.src || '(empty)'} currentSrc=${issue.currentSrc || '(empty)'} alt=${issue.alt || '(empty)'}`,
      ),
      '',
    )
  }

  if (sourceImageErrors.length) {
    mdLines.push(
      '## Source Image Errors',
      '',
      ...sourceImageErrors.map(
        (issue) =>
          `- src=${issue.src || '(empty)'} currentSrc=${issue.currentSrc || '(empty)'} alt=${issue.alt || '(empty)'}`,
      ),
      '',
    )
  }

  if (regionsPath) {
    const sortedModuleStats = sortModuleRegionStats(moduleRegionStats)
    mdLines.push(
      '## Module Region Stats',
      '',
      `- Regions JSON: ${regionsPath}`,
      `- Active modules: ${moduleRegionSummary.activeModules}/${moduleRegionSummary.totalModules}`,
      '',
      ...(sortedModuleStats.length
        ? sortedModuleStats.map((stat) => formatModuleRegionStat(stat))
        : ['- none']),
      '',
    )

    if (moduleRegionDiffFailures.length) {
      mdLines.push(
        '### Module Diff Gate Failed',
        '',
        `Threshold: ${MODULE_DIFF_RATIO_THRESHOLD}`,
        ...moduleRegionDiffFailures.map((stat) => formatModuleRegionStat(stat)),
        '',
      )
    }
  }

  if (moduleDomReconcileSummary) {
    mdLines.push(
      '## Module DOM Reconcile',
      '',
      `- plan modules: ${moduleDomReconcileSummary.planModuleCount}`,
      `- DOM modules: ${moduleDomReconcileSummary.domModuleCount}`,
      `- unplanned DOM modules: ${moduleDomReconcileSummary.unplannedDomModuleIds.join(', ') || 'none'}`,
      `- missing DOM modules: ${moduleDomReconcileSummary.missingDomModuleIds.join(', ') || 'none'}`,
      `- duplicate DOM modules: ${moduleDomReconcileSummary.duplicateDomModuleIds.join(', ') || 'none'}`,
      '',
    )
  }

  if (!layoutBoxPassed) {
    mdLines.push(
      '## ⚠️ Layout Box Gate Failed',
      '',
      'The text-layout feedback loop is NOT active (comparedBlocks = 0).',
      'You must add tracked blocks with `id`, `selectors`, and `region` to the inline `data-text-layout-config`.',
      'An empty blocks array means the layout verification is not actually running — do NOT treat this as a passing result.',
      '',
    )
  }

  if (!workflowLintPassed) {
    mdLines.push(
      '## ⚠️ Workflow Lint Gate Failed',
      '',
      'Critical workflow-lint issues remain.',
      'Do not treat this verify result as passed until `workflow-lint.md` no longer reports critical issues such as nested short-token cells, full-width punctuation tokens, hidden editable text, text bitmap crops, or text-bearing SVG assets.',
      '',
    )
  }

  if (!finalOutputPolicyPassed) {
    mdLines.push(
      '## ⚠️ Final Output Policy Failed',
      '',
      'The final HTML contains a forbidden fallback pattern, hidden semantic DOM, missing local asset reference, or text-bearing/scrubbed image asset.',
      'Do not treat this verify result as passed until `final-output-policy.md` has no critical issues.',
      '',
    )
  }

  await writeTextFile(verifyMarkdownPath, mdLines.join('\n'))

  return verifyReportPath
}

export { writeVerifyReport }
