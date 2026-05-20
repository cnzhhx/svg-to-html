import { type Box } from '../svg-layout.js'

import {
  getCenterY,
  getHorizontalGap,
  getVerticalOverlap,
  overlapLength,
  unionBoxes,
} from './geometry.js'
import { type SvgBoxCandidate } from './types.js'

const selectSeedPath = ({
  anchorBox,
  svgPaths,
}: {
  anchorBox: Box
  svgPaths: SvgBoxCandidate[]
}) => {
  // Start from the closest SVG glyph path to avoid a loose union swallowing
  // decorative strokes that merely overlap the HTML text box.
  const anchorCenterY = getCenterY(anchorBox)
  const maxVerticalDelta = Math.max(14, anchorBox.height * 1.1)
  const maxHorizontalGap = Math.max(80, anchorBox.width * 0.9)

  return svgPaths
    .map((candidate) => {
      const box = candidate.pixelBox
      const verticalDelta = Math.abs(getCenterY(box) - anchorCenterY)
      const horizontalGap = getHorizontalGap(anchorBox, box)
      const overlapX = overlapLength(
        anchorBox.x,
        anchorBox.x + anchorBox.width,
        box.x,
        box.x + box.width,
      )
      const overlapY = getVerticalOverlap(anchorBox, box)
      const heightRatio =
        Math.max(anchorBox.height, box.height) /
        Math.max(1, Math.min(anchorBox.height, box.height))
      const score =
        overlapX * 2 +
        overlapY * 4 -
        horizontalGap * 1.5 -
        verticalDelta * 4 -
        heightRatio * 8

      return {
        candidate,
        horizontalGap,
        score,
        verticalDelta,
      }
    })
    .filter(
      ({ candidate, horizontalGap, verticalDelta }) =>
        verticalDelta <= maxVerticalDelta &&
        horizontalGap <= maxHorizontalGap &&
        candidate.pixelBox.height >= Math.max(3, anchorBox.height * 0.35) &&
        candidate.pixelBox.height <= Math.max(40, anchorBox.height * 1.8),
    )
    .sort((left, right) => right.score - left.score)[0]?.candidate
}

const collectMatchedRow = ({
  anchorBox,
  seed,
  svgPaths,
}: {
  anchorBox: Box
  seed: SvgBoxCandidate
  svgPaths: SvgBoxCandidate[]
}) => {
  // Expand from the seed along the same visual row, bounded by gap and union
  // width so labels beside the target do not get merged into one text box.
  const rowThreshold = Math.max(12, anchorBox.height * 0.9)
  const maxGap = Math.max(28, anchorBox.height * 1.5)
  const maxUnionWidth = Math.max(anchorBox.width * 1.8, anchorBox.width + 120)
  const seedCenterY = getCenterY(seed.pixelBox)

  const rowCandidates = svgPaths
    .filter((candidate) => {
      const box = candidate.pixelBox
      return (
        Math.abs(getCenterY(box) - seedCenterY) <= rowThreshold &&
        box.height >= Math.max(3, anchorBox.height * 0.35) &&
        box.height <= Math.max(40, anchorBox.height * 1.8)
      )
    })
    .sort((left, right) => left.pixelBox.x - right.pixelBox.x)

  const selected = new Map<string, SvgBoxCandidate>([[seed.nodePath, seed]])
  let currentUnion = unionBoxes([seed.pixelBox])

  if (!currentUnion) return [seed]

  let changed = true
  while (changed) {
    changed = false
    rowCandidates.forEach((candidate) => {
      if (selected.has(candidate.nodePath) || !currentUnion) return
      const gap = getHorizontalGap(currentUnion, candidate.pixelBox)
      if (gap > maxGap) return

      const nextUnion = unionBoxes([currentUnion, candidate.pixelBox])
      if (!nextUnion || nextUnion.width > maxUnionWidth) return
      if (getVerticalOverlap(currentUnion, candidate.pixelBox) <= 0) return

      selected.set(candidate.nodePath, candidate)
      currentUnion = nextUnion
      changed = true
    })
  }

  return [...selected.values()].sort(
    (left, right) => left.pixelBox.x - right.pixelBox.x,
  )
}

export const matchSvgBoxForHtmlLine = ({
  htmlBox,
  matchMode,
  svgPaths,
}: {
  htmlBox: Box
  matchMode: 'row' | 'single-path'
  svgPaths: SvgBoxCandidate[]
}) => {
  const seed = selectSeedPath({ anchorBox: htmlBox, svgPaths })
  if (!seed) return null

  if (matchMode === 'single-path') {
    return {
      expectedBox: seed.pixelBox,
      matchedPaths: [seed.nodePath],
    }
  }

  const matchedRow = collectMatchedRow({
    anchorBox: htmlBox,
    seed,
    svgPaths,
  })
  const expectedBox = unionBoxes(matchedRow.map((item) => item.pixelBox))
  if (!expectedBox) return null

  return {
    expectedBox,
    matchedPaths: matchedRow.map((item) => item.nodePath),
  }
}
