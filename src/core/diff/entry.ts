import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { evaluatePage, launchEdge } from '../cdp.js'
import {
  DEFAULT_THRESHOLD,
  DIFF_WRAPPER_NAME,
} from './constants.js'
import type {
  DiffPageResult,
} from './types.js'
import { createDiffWrapper } from './wrapper.js'
import { startStaticServer } from '../static-server.js'
import { toUrlPath, writeTextFile } from '../utils.js'

const createPixelDiff = async ({
  artifactDir,
  renderPngPath,
  scale = 1,
  svgPngPath,
  threshold = DEFAULT_THRESHOLD,
  viewportHeight,
  viewportWidth,
}: {
  artifactDir: string
  renderPngPath: string
  scale?: number
  svgPngPath: string
  threshold?: number
  viewportHeight: number
  viewportWidth: number
}) => {
  const diffWrapperPath = path.join(artifactDir, DIFF_WRAPPER_NAME)
  const diffPngPath = path.join(artifactDir, 'diff.png')

  await writeTextFile(
    diffWrapperPath,
    createDiffWrapper({
      renderImageUrl: toUrlPath(renderPngPath),
      svgImageUrl: toUrlPath(svgPngPath),
      threshold,
    }),
  )

  const server = await startStaticServer()
  const browser = await launchEdge()

  try {
    const diffResult = await evaluatePage<DiffPageResult>({
      deviceScaleFactor: scale,
      evaluateTimeoutMs: 180000,
      expression: 'window.__DIFF_RESULT__',
      port: browser.port,
      url: `${server.origin}${toUrlPath(diffWrapperPath)}`,
      viewportHeight,
      viewportWidth,
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

    return {
      diffCanvasPath: diffWrapperPath,
      report: diffResult.report,
    }
  } finally {
    await server.close()
    await browser.close()
  }
}

export { createPixelDiff }
