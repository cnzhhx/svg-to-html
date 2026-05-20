import { areaOf, containmentRatio } from '../geometry.js'
import type { Box } from '../utils.js'

const formatRem = (value: number) => `${(value / 100).toFixed(3)}rem`

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const sanitizeId = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const boxCenterDistance = (left: Box, right: Box) => {
  const leftCenterX = left.x + left.width / 2
  const leftCenterY = left.y + left.height / 2
  const rightCenterX = right.x + right.width / 2
  const rightCenterY = right.y + right.height / 2
  return Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY)
}

export {
  areaOf,
  boxCenterDistance,
  containmentRatio,
  escapeHtml,
  formatRem,
  sanitizeId,
}
