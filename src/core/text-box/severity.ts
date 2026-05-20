import { type Box } from '../svg-layout.js'

export const formatDeltaSummary = ({
  deltaHeight,
  deltaWidth,
  deltaX,
  deltaY,
}: {
  deltaHeight: number
  deltaWidth: number
  deltaX: number
  deltaY: number
}) => {
  const parts: string[] = []

  if (Math.abs(deltaX) > 2)
    parts.push(deltaX > 0 ? `右偏 ${deltaX}px` : `左偏 ${Math.abs(deltaX)}px`)
  if (Math.abs(deltaY) > 2)
    parts.push(deltaY > 0 ? `下移 ${deltaY}px` : `上移 ${Math.abs(deltaY)}px`)
  if (Math.abs(deltaWidth) > 3) {
    parts.push(
      deltaWidth > 0
        ? `更宽 ${deltaWidth}px`
        : `更窄 ${Math.abs(deltaWidth)}px`,
    )
  }
  if (Math.abs(deltaHeight) > 3) {
    parts.push(
      deltaHeight > 0
        ? `更高 ${deltaHeight}px`
        : `更矮 ${Math.abs(deltaHeight)}px`,
    )
  }

  return parts.length ? parts.join('，') : '位置和尺寸基本重合'
}

export const createSeverity = ({
  deltaHeight,
  deltaWidth,
  deltaX,
  deltaY,
  expectedBox,
}: {
  deltaHeight: number | null
  deltaWidth: number | null
  deltaX: number | null
  deltaY: number | null
  expectedBox: Box | null
}) => {
  if (!expectedBox) return 9999
  return Math.max(
    Math.abs(deltaX ?? 0),
    Math.abs(deltaY ?? 0),
    Math.abs(deltaWidth ?? 0),
    Math.abs(deltaHeight ?? 0),
  )
}
