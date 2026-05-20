import {
  GRID_COLUMNS,
  GRID_ROWS,
  HAIRLINE_MAX_THICKNESS,
  HAIRLINE_MIN_COVERAGE,
  HAIRLINE_THRESHOLD,
  HORIZONTAL_BANDS,
  MAX_BAND_COUNT,
  MAX_CLUSTER_COUNT,
  MAX_GRID_HOTSPOTS,
  VERTICAL_BANDS,
} from './constants.js'
import { DIFF_BROWSER_RUNTIME } from './browser-script-runtime.js'
import type { SerializableRegion } from './types.js'

type DiffBrowserScriptOptions = {
  htmlImageUrl: string
  regions: SerializableRegion[]
  svgImageUrl: string
  threshold: number
}

const createDiffBrowserScript = ({
  htmlImageUrl,
  regions,
  svgImageUrl,
  threshold,
}: DiffBrowserScriptOptions) =>
  [
    `const svgUrl = ${JSON.stringify(svgImageUrl)}`,
    `const htmlUrl = ${JSON.stringify(htmlImageUrl)}`,
    `const threshold = ${threshold}`,
    `const hairlineThreshold = ${HAIRLINE_THRESHOLD}`,
    `const hairlineMaxThickness = ${HAIRLINE_MAX_THICKNESS}`,
    `const hairlineMinCoverage = ${HAIRLINE_MIN_COVERAGE}`,
    `const regions = ${JSON.stringify(regions)}`,
    `const gridColumns = ${GRID_COLUMNS}`,
    `const gridRows = ${GRID_ROWS}`,
    `const horizontalBandCount = ${HORIZONTAL_BANDS}`,
    `const verticalBandCount = ${VERTICAL_BANDS}`,
    `const maxClusterCount = ${MAX_CLUSTER_COUNT}`,
    `const maxBandCount = ${MAX_BAND_COUNT}`,
    `const maxGridHotspots = ${MAX_GRID_HOTSPOTS}`,
    '',
    DIFF_BROWSER_RUNTIME,
  ].join('\n')

export { createDiffBrowserScript }
