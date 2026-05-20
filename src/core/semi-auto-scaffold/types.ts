import type { TextLayoutBlock } from '../text-layout.js'
import type { Box } from '../utils.js'

type OcrBlockRole = 'numeric' | 'paragraph'

type OcrBlockRecord = {
  assignedContainerId: null | string
  assignedNodeId: null | string
  bbox: Box
  confidence: number
  id: string
  observationId: string
  role: OcrBlockRole
  text: string
}

type ShellManifestEntry = {
  assetBox?: Box
  assetKind?: 'bitmap' | 'svg'
  assetName: null | string
  assetPath?: string
  bitmapReason?: string
  box: Box
  containerBox?: Box
  containsIntrinsicText?: boolean
  containsText?: boolean
  containerId: string
  fit?: 'cover' | 'contain'
  kind?: string
  matchedOcrBlockIds?: string[]
  mediaType?: string
  mustUse?: boolean
  ocrStatus?: string
  nodePath: string
  pngPath?: string
  source?: string
  overlapsOcrText?: boolean
  reason: string
  resolvedBox?: Box
  status: 'candidate' | 'ready'
  sourceSvgPath?: string
  svgPath: null | string
  textTreatment?: string
  visibleText?: string
}

type StructureDraftNode = {
  box: Box
  children: string[]
  containerId: null | string
  id: string
  patternKinds: string[]
  repeatGroupId: null | string
  role:
    | 'container'
    | 'group'
    | 'repeat-item'
    | 'repeat-list'
    | 'shell'
    | 'text-group'
    | 'token-cell'
    | 'token-row'
  selector: string
  shellEntryId: null | string
  tag: 'article' | 'div' | 'section'
  textBlockIds: string[]
}

type StructureDraft = {
  designName: string
  nodes: StructureDraftNode[]
  ocrBlockIds: string[]
  pageSelector: string
  topLevelNodeIds: string[]
  trackedBlocks: TextLayoutBlock[]
}

type SemiAutoScaffoldResult = {
  artifactDir: string
  htmlScaffold: string
  ocrBlocks: OcrBlockRecord[]
  ocrBlocksPath: string
  scaffoldDecisionsPath: string
  shellManifest: ShellManifestEntry[]
  shellManifestPath: string
  structureDraft: StructureDraft
  structureDraftPath: string
}

export type {
  OcrBlockRecord,
  OcrBlockRole,
  SemiAutoScaffoldResult,
  ShellManifestEntry,
  StructureDraft,
  StructureDraftNode,
}
