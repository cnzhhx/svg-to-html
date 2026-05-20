import { readFile } from 'node:fs/promises'

import type { OcrResult } from './ocr.js'
import { formatTextIssueSummary } from './text-diff/format.js'
import { createTextDiffIssues } from './text-diff/issues.js'
import {
  buildAutoOcrRegions,
  buildTrackedOcrRegions,
  createOcrCoverageWarnings,
} from './text-diff/region-builders.js'
import type {
  DiffCluster,
  OcrRegionSource,
  TextDiffIssue,
  TextInsightsInput,
  TextInsightsResult,
} from './text-diff/types.js'

const createTextInsights = async ({
  autoOcrRegions,
  clusters,
  height,
  htmlOcrPath,
  svgOcrPath,
  textBoxReportMarkdownPath,
  width,
}: TextInsightsInput): Promise<TextInsightsResult> => {
  const contentPriorityIssues: string[] = []
  const contentAllIssues: string[] = []

  // Read text-box geometry info
  let geometryIssues: string[] = ['- no major geometry issue']
  if (textBoxReportMarkdownPath) {
    try {
      const md = await readFile(textBoxReportMarkdownPath, 'utf8')
      const priorityMatch = md.match(
        /## Priority Issues\n([\s\S]*?)(?=\n##|\n$|$)/,
      )
      if (priorityMatch?.[1]) {
        const lines = priorityMatch[1].trim().split('\n').filter(Boolean)
        if (lines.length)
          geometryIssues = lines.map((line) =>
            line.startsWith('- ') ? line : `- ${line}`,
          )
      }
    } catch {
      // Not available
    }
  }

  // OCR-based content comparison
  if (svgOcrPath && htmlOcrPath) {
    try {
      const svgOcr = JSON.parse(await readFile(svgOcrPath, 'utf8')) as OcrResult
      const htmlOcr = JSON.parse(
        await readFile(htmlOcrPath, 'utf8'),
      ) as OcrResult

      const textIssues = createTextDiffIssues({ htmlOcr, svgOcr }).sort(
        (left, right) => {
          const leftWeight =
            left.classification === 'match'
              ? 0
              : left.classification === 'partial-overlap'
                ? 1
                : 2
          const rightWeight =
            right.classification === 'match'
              ? 0
              : right.classification === 'partial-overlap'
                ? 1
                : 2
          if (rightWeight !== leftWeight) return rightWeight - leftWeight
          return left.similarity - right.similarity
        },
      )

      const coverageWarnings = autoOcrRegions
        ? createOcrCoverageWarnings({
            clusters,
            height,
            ocrRegions: autoOcrRegions,
            width,
          })
        : []

      // Priority: top 8 non-match issues
      const nonMatchIssues = textIssues
        .filter(
          (issue) =>
            issue.classification !== 'match' &&
            issue.classification !== 'no-text',
        )
        .slice(0, 8)
        .map(formatTextIssueSummary)

      if (nonMatchIssues.length) {
        contentPriorityIssues.push(...nonMatchIssues)
      } else if (coverageWarnings.length) {
        contentPriorityIssues.push(...coverageWarnings)
      }

      // All issues
      if (coverageWarnings.length) {
        contentAllIssues.push(...coverageWarnings)
      }
      contentAllIssues.push(
        ...textIssues
          .filter((issue) => issue.classification !== 'no-text')
          .map(formatTextIssueSummary),
      )
    } catch {
      // OCR results not parseable
    }
  }

  const markdown = [
    '# Text Insights',
    '',
    '## Geometry Priority Issues',
    ...geometryIssues,
    '',
    '## Content Priority Issues',
    ...(contentPriorityIssues.length
      ? contentPriorityIssues.map((issue) => `- ${issue}`)
      : ['- no major content issue']),
    '',
    '## Content All Issues',
    ...(contentAllIssues.length
      ? contentAllIssues.map((issue) => `- ${issue}`)
      : ['- none']),
    '',
  ].join('\n')

  return { contentAllIssues, contentPriorityIssues, markdown }
}

export type { DiffCluster, OcrRegionSource, TextDiffIssue, TextInsightsResult }
export { buildAutoOcrRegions, buildTrackedOcrRegions, createTextInsights }
