import { type Box } from '../svg-layout.js'

export type HtmlTextBlock = {
  box: Box
  boxBasis: 'element-box' | 'ink-box'
  configBlockIds: string[]
  configExpectedBox: Box | null
  configLineBoxes: Box[]
  elementSelector: string
  lineBoxes: Box[]
  matchMode: 'row' | 'single-path'
  rawBox: Box
  text: string
}

export type SvgBoxCandidate = {
  nodePath: string
  pixelBox: Box
}

export type TextBoxLineResult = {
  boxBasis: 'element-box' | 'ink-box'
  deltaHeight: number | null
  deltaWidth: number | null
  deltaX: number | null
  deltaY: number | null
  expectedBox: Box | null
  htmlBox: Box
  lineIndex: number
  matchedPathCount: number
  matchedPaths: string[]
  severity: number
  summary: string
}

export type TextBoxBlockResult = {
  boxBasis: 'element-box' | 'ink-box'
  deltaHeight: number | null
  deltaWidth: number | null
  deltaX: number | null
  deltaY: number | null
  elementSelector: string
  expectedBox: Box | null
  htmlBox: Box
  lineCount: number
  lines: TextBoxLineResult[]
  severity: number
  summary: string
  text: string
}

export type TextBoxCompareReport = {
  blocks: TextBoxBlockResult[]
  comparedBlocks: number
  comparedLines: number
  designName: string
  matchedBlocks: number
  matchedLines: number
  priorityIssues: string[]
}
