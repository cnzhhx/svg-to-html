type OcrRegionCandidate = {
  height: number
  id: string
  width: number
  x: number
  y: number
}

const intersectionArea = (left: OcrRegionCandidate, right: OcrRegionCandidate) => {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

const overlapRatio = (left: OcrRegionCandidate, right: OcrRegionCandidate) => {
  const overlap = intersectionArea(left, right)
  if (!overlap) return 0
  const leftArea = Math.max(1, left.width * left.height)
  const rightArea = Math.max(1, right.width * right.height)
  return overlap / Math.min(leftArea, rightArea)
}

const mergeOcrRegions = (...groups: OcrRegionCandidate[][]) => {
  const merged: OcrRegionCandidate[] = []

  groups.flat().forEach((region) => {
    if (merged.some((existing) => overlapRatio(existing, region) >= 0.55)) return
    merged.push(region)
  })

  return merged
}

export type { OcrRegionCandidate }
export { mergeOcrRegions }
