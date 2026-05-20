import type { OcrResult } from '../ocr.js'
import { mergeLineBoxes } from './geometry.js'
import type { OcrLine, TextAnchorOffset, TextDiffIssue } from './types.js'

const normalizeOcrText = (text: string) =>
  text
    .replace(/\s+/g, '')
    .replace(/[，。、""''：；！？,.!?:;"'()（）【】《》\[\]\-]/g, '')
    .toLowerCase()

const createBigrams = (text: string) => {
  if (text.length <= 1) return [text]
  const output: string[] = []
  for (let index = 0; index < text.length - 1; index += 1)
    output.push(text.slice(index, index + 2))
  return output
}

const calculateTextSimilarity = (left: string, right: string) => {
  if (!left && !right) return 1
  if (!left || !right) return 0
  if (left === right) return 1

  const leftBigrams = createBigrams(left)
  const rightBigrams = createBigrams(right)
  const rightCounts = new Map<string, number>()

  rightBigrams.forEach((token) => {
    rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1)
  })

  let overlap = 0
  leftBigrams.forEach((token) => {
    const count = rightCounts.get(token) ?? 0
    if (!count) return
    overlap += 1
    rightCounts.set(token, count - 1)
  })

  return Number(
    (
      (2 * overlap) /
      Math.max(1, leftBigrams.length + rightBigrams.length)
    ).toFixed(4),
  )
}

const classifyTextDiff = ({
  normalizedHtmlText,
  normalizedSvgText,
  similarity,
}: {
  normalizedHtmlText: string
  normalizedSvgText: string
  similarity: number
}): TextDiffIssue['classification'] => {
  if (!normalizedHtmlText && !normalizedSvgText) return 'no-text'
  if (normalizedHtmlText === normalizedSvgText) return 'match'
  if (!normalizedHtmlText && normalizedSvgText) return 'html-missing'
  if (normalizedHtmlText && !normalizedSvgText) return 'html-extra'
  if (
    normalizedHtmlText.includes(normalizedSvgText) ||
    normalizedSvgText.includes(normalizedHtmlText)
  )
    return 'partial-overlap'

  if (similarity >= 0.72) return 'partial-overlap'
  return 'different'
}

const describeAxisShift = ({
  axis,
  delta,
}: {
  axis: 'height' | 'width' | 'x' | 'y'
  delta: number
}) => {
  if (Math.abs(delta) <= 4) return ''
  if (axis === 'x')
    return delta > 0 ? `右偏 ${delta}px` : `左偏 ${Math.abs(delta)}px`
  if (axis === 'y')
    return delta > 0 ? `下移 ${delta}px` : `上移 ${Math.abs(delta)}px`
  if (axis === 'width')
    return delta > 0 ? `更宽 ${delta}px` : `更窄 ${Math.abs(delta)}px`
  return delta > 0 ? `更高 ${delta}px` : `更矮 ${Math.abs(delta)}px`
}

const createOffsetSummary = ({
  deltaHeight,
  deltaWidth,
  deltaX,
  deltaY,
}: {
  deltaHeight: number
  deltaWidth: number
  deltaX: number
  deltaY: number
}) => {
  const parts = [
    describeAxisShift({ axis: 'x', delta: deltaX }),
    describeAxisShift({ axis: 'y', delta: deltaY }),
    describeAxisShift({ axis: 'width', delta: deltaWidth }),
    describeAxisShift({ axis: 'height', delta: deltaHeight }),
  ].filter(Boolean)

  return parts.length ? parts.join('，') : '位置和尺寸基本重合'
}

const createTextAnchorOffset = ({
  htmlLines,
  svgLines,
}: {
  htmlLines: OcrLine[]
  svgLines: OcrLine[]
}): TextAnchorOffset | undefined => {
  const svgBox = mergeLineBoxes(svgLines)
  const htmlBox = mergeLineBoxes(htmlLines)
  if (!svgBox || !htmlBox) return undefined

  const deltaX = htmlBox.x - svgBox.x
  const deltaY = htmlBox.y - svgBox.y
  const deltaWidth = htmlBox.width - svgBox.width
  const deltaHeight = htmlBox.height - svgBox.height

  return {
    deltaHeight,
    deltaWidth,
    deltaX,
    deltaY,
    htmlBox,
    summary: createOffsetSummary({
      deltaHeight,
      deltaWidth,
      deltaX,
      deltaY,
    }),
    svgBox,
  }
}

const createTextDiffIssues = ({
  htmlOcr,
  svgOcr,
}: {
  htmlOcr: OcrResult
  svgOcr: OcrResult
}): TextDiffIssue[] =>
  svgOcr.observations.map((svgObservation) => {
    const htmlObservation = htmlOcr.observations.find(
      (candidate) => candidate.id === svgObservation.id,
    )
    const svgText = svgObservation.text.trim()
    const htmlText = htmlObservation?.text.trim() ?? ''
    const normalizedSvgText = normalizeOcrText(svgText)
    const normalizedHtmlText = normalizeOcrText(htmlText)
    const similarity = calculateTextSimilarity(
      normalizedSvgText,
      normalizedHtmlText,
    )
    const svgBox = mergeLineBoxes(svgObservation.lines)
    const offset = createTextAnchorOffset({
      htmlLines: htmlObservation?.lines ?? [],
      svgLines: svgObservation.lines,
    })

    return {
      classification: classifyTextDiff({
        normalizedHtmlText,
        normalizedSvgText,
        similarity,
      }),
      htmlText,
      id: svgObservation.id,
      normalizedHtmlText,
      normalizedSvgText,
      offset,
      region: svgObservation.region ?? {
        height: 0,
        width: 0,
        x: 0,
        y: 0,
      },
      similarity,
      svgBox,
      svgText,
    }
  })

export { createTextDiffIssues }
