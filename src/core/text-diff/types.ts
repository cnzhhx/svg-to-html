import type { OcrResult } from '../ocr.js'
import type { Region } from '../utils.js'

type OcrRegionSource = {
  height: number
  id: string
  width: number
  x: number
  y: number
}

type DiffCluster = {
  boundingBox: { height: number; width: number; x: number; y: number }
  [key: string]: unknown
}

type OcrBoundingBox = {
  height: number
  width: number
  x: number
  y: number
}

type OcrLine = OcrResult['observations'][number]['lines'][number]

type TextAnchorOffset = {
  deltaHeight: number
  deltaWidth: number
  deltaX: number
  deltaY: number
  htmlBox: OcrBoundingBox
  summary: string
  svgBox: OcrBoundingBox
}

type TextDiffIssue = {
  classification:
    | 'different'
    | 'html-extra'
    | 'html-missing'
    | 'match'
    | 'no-text'
    | 'partial-overlap'
  htmlText: string
  id: string
  normalizedHtmlText: string
  normalizedSvgText: string
  offset?: TextAnchorOffset
  region: Region
  similarity: number
  svgBox?: OcrBoundingBox
  svgText: string
}

type TextInsightsInput = {
  autoOcrRegions?: OcrRegionSource[]
  clusters: DiffCluster[]
  height: number
  htmlOcrPath?: string
  svgOcrPath?: string
  textBoxReportMarkdownPath?: string
  width: number
}

type TextInsightsResult = {
  contentAllIssues: string[]
  contentPriorityIssues: string[]
  markdown: string
}

export type {
  DiffCluster,
  OcrBoundingBox,
  OcrLine,
  OcrRegionSource,
  TextAnchorOffset,
  TextDiffIssue,
  TextInsightsInput,
  TextInsightsResult,
}
