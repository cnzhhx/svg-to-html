type Box = {
  height: number
  width: number
  x: number
  y: number
}

type Region = Box & { id?: string }

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

const containmentRatio = (inner: Box, outer: Box) =>
  intersectionArea(inner, outer) / safeAreaOf(inner)

const overlapRatio = (left: Box, right: Box) =>
  intersectionArea(left, right) / Math.max(1, Math.min(areaOf(left), areaOf(right)))

const centerOf = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

const round = (value: number, digits = 3) => Number(value.toFixed(digits))

const pointInside = (point: { x: number; y: number }, box: Box) =>
  point.x >= box.x && point.x <= rightOf(box) && point.y >= box.y && point.y <= bottomOf(box)

const overlapLength = (
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) => Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart))

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const isFiniteBox = (box: unknown): box is Box =>
  typeof box === 'object' &&
  box !== null &&
  'x' in box &&
  'y' in box &&
  'width' in box &&
  'height' in box &&
  [(box as Box).x, (box as Box).y, (box as Box).width, (box as Box).height].every(
    (v) => typeof v === 'number' && Number.isFinite(v),
  )

const isPageScaleBox = (box: Box, pageWidth: number, pageHeight: number) =>
  box.width >= pageWidth * 0.5 && box.height >= pageHeight * 0.5

const unionBoxes = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => rightOf(box)))
  const bottom = Math.max(...boxes.map((box) => bottomOf(box)))
  return {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  }
}

const uniqueStrings = (strings: string[]): string[] => [...new Set(strings)]

export type { Box, Region }
export {
  areaOf,
  bottomOf,
  centerOf,
  centerXOf,
  centerYOf,
  clamp,
  containmentRatio,
  intersectionArea,
  isFiniteBox,
  isPageScaleBox,
  overlapLength,
  overlapRatio,
  pointInside,
  rightOf,
  round,
  unionBoxes,
  uniqueStrings,
}
