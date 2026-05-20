import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  DIFF_RATIO_THRESHOLD,
  MODULE_DIFF_RATIO_THRESHOLD,
} from '../../config/runtime.js'
import { resolveDesignPair } from '../../core/utils.js'
import { sessionStore, type Session, type SessionResult } from '../../session-store.js'
import { verifyDesign, type VerifyResult } from '../verify.js'
import type { VerifyMode } from '../verify/types.js'
import { archiveSessionCheckpoint } from './checkpoint.js'

const buildVerifyStepResult = (
  session: Session,
  verifyResult: VerifyResult,
): SessionResult => ({
  artifactDir: session.artifactDir,
  compareHtmlPath: session.compareHtmlPath,
  diffRatio: verifyResult.diffRatio,
  diffPngPath: verifyResult.diffPngPath,
  htmlPath: session.htmlPath,
  htmlPngPath: verifyResult.htmlPngPath,
  layoutBoxPassed:
    verifyResult.mode === 'fast'
      ? session.result.layoutBoxPassed ?? verifyResult.layoutBoxPassed
      : verifyResult.layoutBoxPassed,
  layoutBoxReportPath:
    verifyResult.layoutBoxReportPath ?? session.result.layoutBoxReportPath,
  finalOutputPolicyPassed: verifyResult.finalOutputPolicyPassed,
  finalOutputPolicyPath:
    verifyResult.finalOutputPolicyPath ?? session.result.finalOutputPolicyPath,
  finalOutputReady: session.result.finalOutputReady,
  svgPngPath: verifyResult.svgPngPath,
  textBoxReportPath:
    verifyResult.textBoxReportPath ?? session.result.textBoxReportPath,
  textInsightsPath:
    verifyResult.textInsightsPath ?? session.result.textInsightsPath,
  textContentPriorityIssueCount:
    verifyResult.textContentPriorityIssueCount ??
    session.result.textContentPriorityIssueCount,
  textGeometryPriorityIssueCount:
    verifyResult.textGeometryPriorityIssueCount ??
    session.result.textGeometryPriorityIssueCount,
  textPriorityIssueCount:
    verifyResult.textPriorityIssueCount ?? session.result.textPriorityIssueCount,
  workflowLintPassed:
    verifyResult.mode === 'fast'
      ? session.result.workflowLintPassed ?? verifyResult.workflowLintPassed
      : verifyResult.workflowLintPassed,
  workflowLintPath:
    verifyResult.workflowLintPath ?? session.result.workflowLintPath,
  verifyReportPath: verifyResult.verifyReportPath,
  ocrProvider: verifyResult.ocrProvider,
  regionsPath: verifyResult.regionsPath,
  moduleDomReconcileMarkdownPath: verifyResult.moduleDomReconcileMarkdownPath,
  moduleDomReconcilePath: verifyResult.moduleDomReconcilePath,
  moduleDomReconcileSummary: verifyResult.moduleDomReconcileSummary,
  moduleRegionDiffFailures: verifyResult.moduleRegionDiffFailures,
  moduleRegionDiffPassed: verifyResult.moduleRegionDiffPassed,
  moduleRegionDiffThreshold: verifyResult.moduleRegionDiffThreshold,
  moduleRegionStats: verifyResult.moduleRegionStats,
  moduleRegionSummary: verifyResult.moduleRegionSummary,
  verifyMode: verifyResult.mode,
  fontRenderingLimitLikely: verifyResult.fontRenderingLimitLikely,
  fontRenderingLimitReason: verifyResult.fontRenderingLimitReason,
})

const runVerify = async (
  sessionId: string,
  svgPath: string,
  artifactDir: string,
  iteration?: number,
  manageNode = true,
  options: {
    mode?: VerifyMode
    reuseCachedOcr?: boolean
  } = {},
): Promise<VerifyResult> => {
  const iterLabel = iteration !== undefined ? ` (round ${iteration})` : ''
  const mode = options.mode ?? 'full'
  if (manageNode) {
    sessionStore.startWorkflowNode(sessionId, 'verify', {
      detail:
        iteration && iteration > 1
          ? `正在执行第 ${iteration} 轮${mode === 'fast' ? '快速' : '完整'}视觉校验`
          : `正在执行首轮${mode === 'fast' ? '快速' : '完整'}视觉校验`,
      iteration: iteration ?? 1,
    })
  } else {
    sessionStore.setWorkflowMeta(sessionId, {
      detail:
        iteration && iteration > 1
          ? `迭代修正中：第 ${iteration} 轮${mode === 'fast' ? '快速' : '完整'}视觉校验`
          : `正在执行${mode === 'fast' ? '快速' : '完整'}视觉校验`,
      iteration: iteration ?? 1,
    })
  }
  sessionStore.startStep(sessionId, 'verify')
  sessionStore.addLog(
    sessionId,
    `[pipeline] starting ${mode} verify pass${iterLabel}`,
  )
  const currentSession = sessionStore.get(sessionId)
  const scale = currentSession?.scale
  const verifiedDesign = await resolveDesignPair(svgPath, { scale })
  const regionsPath = currentSession?.result.moduleDiffRegionsPath
  const effectiveRegionsPath = regionsPath && existsSync(regionsPath) ? regionsPath : undefined
  if (regionsPath && !effectiveRegionsPath) {
    sessionStore.addLog(
      sessionId,
      `[verify] module regions skipped because file is missing: ${regionsPath}`,
    )
  }
  const verifyResult = await verifyDesign(
    verifiedDesign.svgPath,
    (message) => {
      sessionStore.addLog(sessionId, `[verify] ${message}`)
    },
    artifactDir,
    effectiveRegionsPath,
    {
      mode,
      reuseCachedOcr: options.reuseCachedOcr,
      scale,
    },
  )
  const session = sessionStore.get(sessionId)
  if (!session) throw new Error('Session not found')

  const verifyStepResult = buildVerifyStepResult(session, verifyResult)

  await archiveSessionCheckpoint({
    sessionId,
    round: iteration ?? 1,
    stage: 'verify',
    diffRatio: verifyResult.diffRatio,
    note: `Verify pass ${iteration ?? 1}`,
    metadata: {
      layoutBoxPassed: verifyResult.layoutBoxPassed,
      finalOutputPolicyPassed: verifyResult.finalOutputPolicyPassed,
      workflowLintPassed: verifyResult.workflowLintPassed,
      ocrProvider: verifyResult.ocrProvider,
      moduleDomReconcileSummary: verifyResult.moduleDomReconcileSummary,
      moduleRegionDiffFailures: verifyResult.moduleRegionDiffFailures,
      moduleRegionDiffPassed: verifyResult.moduleRegionDiffPassed,
      moduleRegionDiffThreshold: verifyResult.moduleRegionDiffThreshold,
      moduleRegionSummary: verifyResult.moduleRegionSummary,
      mode: verifyResult.mode,
      fontRenderingLimitLikely: verifyResult.fontRenderingLimitLikely,
      fontRenderingLimitReason: verifyResult.fontRenderingLimitReason,
      textContentPriorityIssueCount: verifyResult.textContentPriorityIssueCount,
      textGeometryPriorityIssueCount: verifyResult.textGeometryPriorityIssueCount,
      textPriorityIssueCount: verifyResult.textPriorityIssueCount,
    },
    materials: [
      {
        kind: 'file',
        label: 'Rendered SVG PNG',
        sourcePath: verifyResult.svgPngPath,
        optional: true,
      },
      {
        kind: 'file',
        label: 'Rendered HTML PNG',
        sourcePath: verifyResult.htmlPngPath,
        optional: true,
      },
      {
        kind: 'file',
        label: 'Diff PNG',
        sourcePath: verifyResult.diffPngPath,
        optional: true,
      },
      {
        kind: 'file',
        label: 'Diff Report',
        sourcePath: path.join(artifactDir, 'diff-report.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Verify Report JSON',
        sourcePath: verifyResult.verifyReportPath,
        optional: true,
      },
      {
        kind: 'file',
        label: 'Workflow Lint JSON',
        sourcePath: path.join(artifactDir, 'workflow-lint.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Final Output Policy JSON',
        sourcePath: path.join(artifactDir, 'final-output-policy.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Module DOM Reconcile JSON',
        sourcePath: verifyResult.moduleDomReconcilePath ?? path.join(artifactDir, 'modules', 'module-dom-reconcile.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Layout Box JSON',
        sourcePath: path.join(artifactDir, 'box-report.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Text Box JSON',
        sourcePath: path.join(artifactDir, 'text-box-report.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'HTML Snapshot',
        sourcePath: session.htmlPath,
        optional: true,
      },
      {
        kind: 'json',
        label: 'Verify Summary',
        targetName: 'summary.json',
        payload: verifyStepResult,
      },
    ],
  })

  if (!verifyResult.layoutBoxPassed) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify gate warning (layout-box)${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, ocr=${verifyResult.ocrProvider}`,
    )
  }

  if (verifyResult.diffRatio > DIFF_RATIO_THRESHOLD) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify gate warning (diff-ratio)${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, threshold=${(DIFF_RATIO_THRESHOLD * 100).toFixed(2)}%`,
    )
  }

  if (!verifyResult.workflowLintPassed) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify gate warning (workflow-lint)${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, ocr=${verifyResult.ocrProvider}`,
    )
  }

  if (verifyResult.finalOutputPolicyPassed === false) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify gate warning (final-output-policy)${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, ocr=${verifyResult.ocrProvider}`,
    )
  }

  if (verifyResult.moduleRegionDiffPassed === false) {
    const failedModules = verifyResult.moduleRegionDiffFailures
      ?.map((stat) => `${stat.id}=${(stat.diffRatio * 100).toFixed(2)}%`)
      .join(', ')
    sessionStore.addLog(
      sessionId,
      `[pipeline] verify gate warning (module-region-diff)${iterLabel}: threshold=${(MODULE_DIFF_RATIO_THRESHOLD * 100).toFixed(2)}%, failed=${failedModules || 'unknown'}`,
    )
  }

  const unplannedDomModules =
    verifyResult.moduleDomReconcileSummary?.unplannedDomModuleIds ?? []
  if (unplannedDomModules.length > 0) {
    sessionStore.addLog(
      sessionId,
      `[pipeline] module DOM reconcile warning${iterLabel}: unplanned final module(s) ${unplannedDomModules.join(', ')}`,
    )
  }

  sessionStore.addLog(
    sessionId,
    `[pipeline] ${mode} verify complete${iterLabel}: diff=${(verifyResult.diffRatio * 100).toFixed(2)}%, ocr=${verifyResult.ocrProvider}${verifyResult.fontRenderingLimitLikely ? ', font-limit=likely' : ''}`,
  )
  if (manageNode) {
    sessionStore.completeWorkflowNode(
      sessionId,
      'verify',
      `${mode === 'fast' ? '快速' : '完整'}视觉校验完成，当前 diff ${(verifyResult.diffRatio * 100).toFixed(2)}%`,
    )
  } else {
    sessionStore.setWorkflowMeta(sessionId, {
      detail: `迭代修正中：第 ${iteration ?? 1} 轮${mode === 'fast' ? '快速' : '完整'}校验完成，diff ${(verifyResult.diffRatio * 100).toFixed(2)}%`,
      iteration: iteration ?? 1,
    })
  }
  sessionStore.completeStep(sessionId, 'verify', verifyStepResult)

  return verifyResult
}

export { buildVerifyStepResult, runVerify }
