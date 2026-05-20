import { type Box } from '../svg-layout.js'

export const overlapLength = (
  startA: number,
  endA: number,
  startB: number,
  endB: number,
) => Math.max(0, Math.min(endA, endB) - Math.max(startA, startB))

export const unionBoxes = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  boxes.forEach((box) => {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  })

  return {
    height: Number((maxY - minY).toFixed(3)),
    width: Number((maxX - minX).toFixed(3)),
    x: Number(minX.toFixed(3)),
    y: Number(minY.toFixed(3)),
  }
}

export const getCenterY = (box: Box) => box.y + box.height / 2

export const getHorizontalGap = (left: Box, right: Box) => {
  if (left.x + left.width < right.x) return right.x - (left.x + left.width)
  if (right.x + right.width < left.x) return left.x - (right.x + right.width)
  return 0
}

export const getVerticalOverlap = (left: Box, right: Box) =>
  overlapLength(left.y, left.y + left.height, right.y, right.y + right.height)
