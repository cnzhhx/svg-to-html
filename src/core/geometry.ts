type Box = {
  height: number
  width: number
  x: number
  y: number
}

type BoxSize = Pick<Box, 'height' | 'width'>

const areaOf = (box: BoxSize) => box.width * box.height

const safeAreaOf = (box: BoxSize) => Math.max(1, areaOf(box))

const rightOf = (box: Pick<Box, 'width' | 'x'>) => box.x + box.width

const bottomOf = (box: Pick<Box, 'height' | 'y'>) => box.y + box.height

const centerXOf = (box: Pick<Box, 'width' | 'x'>) => box.x + box.width / 2

const centerYOf = (box: Pick<Box, 'height' | 'y'>) => box.y + box.height / 2

const intersectionArea = (left: Box, right: Box) => {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(rightOf(left), rightOf(right))
  const y2 = Math.min(bottomOf(left), bottomOf(right))
  if (x2 <= x1 || y2 <= y1) return 0
  return (x2 - x1) * (y2 - y1)
}

const overlapArea = intersectionArea

const containmentRatio = (inner: Box, outer: Box) =>
  intersectionArea(inner, outer) / safeAreaOf(inner)

const overlapRatio = (left: Box, right: Box) =>
  intersectionArea(left, right) / Math.max(1, Math.min(areaOf(left), areaOf(right)))

export type { Box, BoxSize }
export {
  areaOf,
  bottomOf,
  centerXOf,
  centerYOf,
  containmentRatio,
  intersectionArea,
  overlapArea,
  overlapRatio,
  rightOf,
  safeAreaOf,
}
