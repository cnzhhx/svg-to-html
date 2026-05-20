import type { Region } from '../utils.js'

type DiffBoundingBox = {
  height: number
  width: number
  x: number
  y: number
}

type RegionStat = {
  boundingBox: DiffBoundingBox | null
  diffPixels: number
  diffRatio: number
  id: string
  maxChannelDelta: number
}

type DiffCluster = {
  averageChannelDelta: number
  boundingBox: DiffBoundingBox
  centroid: {
    x: number
    y: number
  }
  diffPixels: number
  diffRatioWithinBounds: number
  dominantAlphaTrend: 'html_less_opaque' | 'html_more_opaque' | 'mixed'
  dominantLumaTrend: 'html_darker' | 'html_lighter' | 'mixed'
  htmlDarkerPixels: number
  htmlLighterPixels: number
  htmlLessOpaquePixels: number
  htmlMoreOpaquePixels: number
  id: string
  maxChannelDelta: number
}

type AxisBand = {
  averageChannelDelta: number
  axis: 'x' | 'y'
  diffPixels: number
  diffRatio: number
  end: number
  id: string
  start: number
}

type GridHotspot = {
  averageChannelDelta: number
  column: number
  diffPixels: number
  diffRatio: number
  height: number
  row: number
  width: number
  x: number
  y: number
}

type AgentHint = {
  kind: 'cluster' | 'grid-hotspot' | 'hairline-y' | 'x-band' | 'y-band'
  priority: number
  summary: string
}

type HairlineHotspot = {
  averageChannelDelta: number
  coverageRatio: number
  end: number
  height: number
  start: number
}

type DiffReport = {
  agentHints: AgentHint[]
  averageChannelDelta: number
  boundingBox: null | DiffBoundingBox
  clusters: DiffCluster[]
  diffPixels: number
  diffRatio: number
  gridHotspots: GridHotspot[]
  hairlineHotspots: HairlineHotspot[]
  height: number
  horizontalBands: AxisBand[]
  maxChannelDelta: number
  regionStats: RegionStat[]
  threshold: number
  totalPixels: number
  verticalBands: AxisBand[]
  width: number
}

type DiffPageResult = {
  diffDataUrl: string
  report: DiffReport
}

type SerializableRegion = Region & { id: string }

export type {
  AgentHint,
  AxisBand,
  DiffBoundingBox,
  DiffCluster,
  DiffPageResult,
  DiffReport,
  GridHotspot,
  HairlineHotspot,
  RegionStat,
  SerializableRegion,
}
