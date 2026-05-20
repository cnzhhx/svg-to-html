import type { Region } from '../utils.js'
import type { OcrBoundingBox, OcrLine, OcrRegionSource } from './types.js'

const intersectionArea = (left: Region, right: Region) => {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

const overlapRatio = (left: Region, right: Region) => {
  const overlap = intersectionArea(left, right)
  if (!overlap) return 0
  const leftArea = Math.max(1, left.width * left.height)
  const rightArea = Math.max(1, right.width * right.height)
  return overlap / Math.min(leftArea, rightArea)
}

const expandRegion = ({
  boundsHeight,
  boundsWidth,
  paddingX,
  paddingY,
  region,
}: {
  boundsHeight: number
  boundsWidth: number
  paddingX: number
  paddingY: number
  region: OcrRegionSource
}): OcrRegionSource => {
  const x = Math.max(0, region.x - paddingX)
  const y = Math.max(0, region.y - paddingY)
  const maxWidth = boundsWidth - x
  const maxHeight = boundsHeight - y

  return {
    ...region,
    height: Math.min(maxHeight, region.height + paddingY * 2),
    width: Math.min(maxWidth, region.width + paddingX * 2),
    x,
    y,
  }
}

const uniqSortedByThreshold = (values: number[], threshold: number) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.reduce<number[]>((result, value) => {
    const last = result.at(-1)
    if (last === undefined || Math.abs(value - last) > threshold)
      result.push(value)
    return result
  }, [])
}

const appendIfDistinct = ({
  candidate,
  collection,
}: {
  candidate: OcrRegionSource
  collection: OcrRegionSource[]
}) => {
  const duplicated = collection.some(
    (existing) => overlapRatio(existing, candidate) >= 0.55,
  )
  if (!duplicated) collection.push(candidate)
}

const mergeLineBoxes = (lines: OcrLine[]): OcrBoundingBox | undefined => {
  if (!lines.length) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  lines.forEach((line) => {
    minX = Math.min(minX, line.boundingBox.x)
    minY = Math.min(minY, line.boundingBox.y)
    maxX = Math.max(maxX, line.boundingBox.x + line.boundingBox.width)
    maxY = Math.max(maxY, line.boundingBox.y + line.boundingBox.height)
  })

  return {
    height: Math.max(0, Math.round(maxY - minY)),
    width: Math.max(0, Math.round(maxX - minX)),
    x: Math.round(minX),
    y: Math.round(minY),
  }
}

export {
  appendIfDistinct,
  expandRegion,
  mergeLineBoxes,
  overlapRatio,
  uniqSortedByThreshold,
}
