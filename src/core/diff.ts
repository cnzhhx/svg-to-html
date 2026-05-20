import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { evaluatePage, launchEdge } from './cdp.js'
import {
  DEFAULT_THRESHOLD,
  DIFF_WRAPPER_NAME,
} from './diff/constants.js'
import { renderDiffInsightsMarkdown } from './diff/report.js'
import { resolveDiffRegions } from './diff/regions.js'
import type {
  DiffBoundingBox,
  DiffPageResult,
  RegionStat,
} from './diff/types.js'
import { createDiffWrapper } from './diff/wrapper.js'
import startStaticServer from './static-server.js'
import { type Region, toUrlPath, writeJsonFile, writeTextFile } from './utils.js'

const createPixelDiff = async ({
  artifactDir,
  htmlPngPath,
  regions,
  regionsPath,
  svgPngPath,
  threshold = DEFAULT_THRESHOLD,
}: {
  artifactDir: string
  htmlPngPath: string
  regions?: Region[]
  regionsPath?: string
  svgPngPath: string
  threshold?: number
}) => {
  const diffRegions = await resolveDiffRegions({ regions, regionsPath })
  const diffWrapperPath = path.join(artifactDir, DIFF_WRAPPER_NAME)
  const diffPngPath = path.join(artifactDir, 'diff.png')
  const diffReportPath = path.join(artifactDir, 'diff-report.json')
  const diffInsightsPath = path.join(artifactDir, 'diff-insights.md')

  await writeTextFile(
    diffWrapperPath,
    createDiffWrapper({
      htmlImageUrl: toUrlPath(htmlPngPath),
      regions: diffRegions,
      svgImageUrl: toUrlPath(svgPngPath),
      threshold,
    }),
  )

  const server = await startStaticServer()
  const browser = await launchEdge()

  try {
    const diffResult = await evaluatePage<DiffPageResult>({
      expression: 'window.__DIFF_RESULT__',
      port: browser.port,
      url: `${server.origin}${toUrlPath(diffWrapperPath)}`,
      viewportHeight: 2400,
      viewportWidth: 1200,
    })

    if (!diffResult.diffDataUrl)
      throw new Error('Failed to produce diff result from browser canvas')

    await writeFile(
      diffPngPath,
      Buffer.from(
        diffResult.diffDataUrl.replace(/^data:image\/png;base64,/, ''),
        'base64',
      ),
    )
    await writeJsonFile(diffReportPath, diffResult.report)
    await writeTextFile(
      diffInsightsPath,
      renderDiffInsightsMarkdown(diffResult.report),
    )

    return {
      diffCanvasPath: diffWrapperPath,
      diffInsightsPath,
      diffPngPath,
      diffReportPath,
      report: diffResult.report,
    }
  } finally {
    await server.close()
    await browser.close()
  }
}

export type { DiffBoundingBox, RegionStat }
export { createPixelDiff }
