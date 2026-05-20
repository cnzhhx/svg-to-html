import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { launchEdge } from '../cdp.js'
import { type Box, readSvgLayout, type SvgLayoutResult } from '../svg-layout.js'
import startStaticServer from '../static-server.js'
import {
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
} from '../utils.js'

import { readHtmlTextBlocks } from './browser-measure.js'
import { unionBoxes } from './geometry.js'
import { matchSvgBoxForHtmlLine } from './matching.js'
import { createSeverity, formatDeltaSummary } from './severity.js'
import {
  type SvgBoxCandidate,
  type TextBoxBlockResult,
  type TextBoxCompareReport,
  type TextBoxLineResult,
} from './types.js'

const readReusableSvgLayout = async ({
  artifactDir,
  svgPath,
}: {
  artifactDir: string
  svgPath: string
}): Promise<SvgLayoutResult | null> => {
  const jsonPath = path.join(artifactDir, 'svg-layout.json')

  try {
    const [layoutStat, svgStat] = await Promise.all([
      stat(jsonPath),
      stat(svgPath),
    ])
    if (layoutStat.mtimeMs + 1 < svgStat.mtimeMs) return null

    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as SvgLayoutResult
    if (
      typeof parsed.nodeCount !== 'number' ||
      !Array.isArray(parsed.nodes) ||
      !parsed.scale ||
      !parsed.svgViewBox
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const createTextBoxReport = async ({
  artifactDir,
  htmlPath,
  inputPath,
  scale,
}: {
  artifactDir: string
  htmlPath?: string
  inputPath: string
  scale?: number
}) => {
  const resolvedDesign = htmlPath
    ? await resolveSvgDesign(inputPath, { scale })
    : await resolveDesignPair(inputPath, { scale })
  const design = htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : resolvedDesign
  const outputPath = path.join(artifactDir, 'text-box-report.json')
  const markdownPath = path.join(artifactDir, 'text-box-report.md')
  const svgLayout =
    (await readReusableSvgLayout({
      artifactDir,
      svgPath: design.svgPath,
    })) ??
    (
      await readSvgLayout({
        design,
        wrapperName: 'text-box-svg-source.html',
        wrapperRoot: artifactDir,
      })
    ).result

  const svgPaths: SvgBoxCandidate[] = svgLayout.nodes
    .filter(
      (node): node is typeof node & { pixelBox: Box } =>
        (node.tag === 'path' || node.tag === 'text') && node.pixelBox !== null,
    )
    .map((node) => ({
      nodePath: node.nodePath,
      pixelBox: node.pixelBox,
    }))

  const server = await startStaticServer()
  const browser = await launchEdge()

  try {
    const htmlBlocks = await readHtmlTextBlocks({
      designHeight: design.height,
      designWidth: design.width,
      htmlUrl: `${server.origin}${toUrlPath(design.htmlPath)}`,
      port: browser.port,
    })

    const blocks = htmlBlocks.map<TextBoxBlockResult>((block) => {
      const lineResults = block.lineBoxes.map<TextBoxLineResult>(
        (lineBox, lineIndex) => {
          const expectedFromConfig =
            block.configLineBoxes.length === block.lineBoxes.length
              ? (block.configLineBoxes[lineIndex] ?? null)
              : block.lineBoxes.length === 1
                ? (block.configExpectedBox ?? block.configLineBoxes[0] ?? null)
                : null

          if (expectedFromConfig) {
            const deltaX = Number((lineBox.x - expectedFromConfig.x).toFixed(3))
            const deltaY = Number((lineBox.y - expectedFromConfig.y).toFixed(3))
            const deltaWidth = Number(
              (lineBox.width - expectedFromConfig.width).toFixed(3),
            )
            const deltaHeight = Number(
              (lineBox.height - expectedFromConfig.height).toFixed(3),
            )

            return {
              boxBasis: block.boxBasis,
              deltaHeight,
              deltaWidth,
              deltaX,
              deltaY,
              expectedBox: expectedFromConfig,
              htmlBox: lineBox,
              lineIndex,
              matchedPathCount: block.configBlockIds.length,
              matchedPaths: block.configBlockIds.map((id) => `text-layout:${id}`),
              severity: createSeverity({
                deltaHeight,
                deltaWidth,
                deltaX,
                deltaY,
                expectedBox: expectedFromConfig,
              }),
              summary: formatDeltaSummary({
                deltaHeight,
                deltaWidth,
                deltaX,
                deltaY,
              }),
            }
          }

          const matched = matchSvgBoxForHtmlLine({
            htmlBox: lineBox,
            matchMode: block.matchMode,
            svgPaths,
          })

          if (!matched) {
            return {
              boxBasis: block.boxBasis,
              deltaHeight: null,
              deltaWidth: null,
              deltaX: null,
              deltaY: null,
              expectedBox: null,
              htmlBox: lineBox,
              lineIndex,
              matchedPathCount: 0,
              matchedPaths: [],
              severity: 9999,
              summary: '未匹配到对应 SVG 文本盒',
            }
          }

          const deltaX = Number((lineBox.x - matched.expectedBox.x).toFixed(3))
          const deltaY = Number((lineBox.y - matched.expectedBox.y).toFixed(3))
          const deltaWidth = Number(
            (lineBox.width - matched.expectedBox.width).toFixed(3),
          )
          const deltaHeight = Number(
            (lineBox.height - matched.expectedBox.height).toFixed(3),
          )

          return {
            boxBasis: block.boxBasis,
            deltaHeight,
            deltaWidth,
            deltaX,
            deltaY,
            expectedBox: matched.expectedBox,
            htmlBox: lineBox,
            lineIndex,
            matchedPathCount: matched.matchedPaths.length,
            matchedPaths: matched.matchedPaths,
            severity: createSeverity({
              deltaHeight,
              deltaWidth,
              deltaX,
              deltaY,
              expectedBox: matched.expectedBox,
            }),
            summary: formatDeltaSummary({
              deltaHeight,
              deltaWidth,
              deltaX,
              deltaY,
            }),
          }
        },
      )

      const matchedBoxes = lineResults
        .map((line) => line.expectedBox)
        .filter((item): item is Box => item !== null)
      const expectedBox = block.configExpectedBox ?? unionBoxes(matchedBoxes)

      if (!expectedBox) {
        return {
          boxBasis: block.boxBasis,
          deltaHeight: null,
          deltaWidth: null,
          deltaX: null,
          deltaY: null,
          elementSelector: block.elementSelector,
          expectedBox: null,
          htmlBox: block.box,
          lineCount: block.lineBoxes.length,
          lines: lineResults,
          severity: 9999,
          summary: '整块文本未匹配到对应 SVG 文本盒',
          text: block.text,
        }
      }

      const deltaX = Number((block.box.x - expectedBox.x).toFixed(3))
      const deltaY = Number((block.box.y - expectedBox.y).toFixed(3))
      const deltaWidth = Number(
        (block.box.width - expectedBox.width).toFixed(3),
      )
      const deltaHeight = Number(
        (block.box.height - expectedBox.height).toFixed(3),
      )

      return {
        boxBasis: block.boxBasis,
        deltaHeight,
        deltaWidth,
        deltaX,
        deltaY,
        elementSelector: block.elementSelector,
        expectedBox,
        htmlBox: block.box,
        lineCount: block.lineBoxes.length,
        lines: lineResults,
        severity: createSeverity({
          deltaHeight,
          deltaWidth,
          deltaX,
          deltaY,
          expectedBox,
        }),
        summary: formatDeltaSummary({
          deltaHeight,
          deltaWidth,
          deltaX,
          deltaY,
        }),
        text: block.text,
      }
    })

    const sortedIssues = [...blocks].sort(
      (left, right) => right.severity - left.severity,
    )
    const priorityIssues = sortedIssues
      .filter(
        (block) =>
          !block.expectedBox ||
          Math.abs(block.deltaX ?? 0) > 2 ||
          Math.abs(block.deltaY ?? 0) > 2 ||
          Math.abs(block.deltaWidth ?? 0) > 3 ||
          Math.abs(block.deltaHeight ?? 0) > 3,
      )
      .slice(0, 12)
      .map((block) => {
        const textPreview =
          block.text.length > 24 ? `${block.text.slice(0, 24)}...` : block.text
        return `文本块 "${textPreview}" (${block.elementSelector}, basis=${block.boxBasis})：${block.summary}`
      })

    const report: TextBoxCompareReport = {
      blocks,
      comparedBlocks: blocks.length,
      comparedLines: blocks.reduce((sum, block) => sum + block.lineCount, 0),
      designName: design.designName,
      matchedBlocks: blocks.filter((block) => block.expectedBox).length,
      matchedLines: blocks.reduce(
        (sum, block) =>
          sum + block.lines.filter((line) => line.expectedBox).length,
        0,
      ),
      priorityIssues,
    }

    await writeJsonFile(outputPath, report)
    await writeTextFile(
      markdownPath,
      [
        '# Text Box Report',
        '',
        `- design: ${design.designName}`,
        `- comparedBlocks: ${report.comparedBlocks}`,
        `- matchedBlocks: ${report.matchedBlocks}`,
        `- comparedLines: ${report.comparedLines}`,
        `- matchedLines: ${report.matchedLines}`,
        '',
        '## Priority Issues',
        ...(priorityIssues.length
          ? priorityIssues.map((item) => `- ${item}`)
          : ['- no major geometry issue']),
        '',
        '## Blocks',
        ...blocks.map((block) => {
          const textPreview =
            block.text.length > 36
              ? `${block.text.slice(0, 36)}...`
              : block.text
          return `- "${textPreview}" selector=\`${block.elementSelector}\`, basis=\`${block.boxBasis}\`, ${block.summary}`
        }),
        '',
      ].join('\n'),
    )

    return { markdownPath, outputPath, report }
  } finally {
    await server.close()
    await browser.close()
  }
}
