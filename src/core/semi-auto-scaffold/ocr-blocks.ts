import type { ContainerRecord } from '../container-layout/types.js'
import type { OcrResult } from '../ocr.js'
import type { Box } from '../utils.js'
import type { OcrBlockRecord, OcrBlockRole } from './types.js'
import {
  areaOf,
  boxCenterDistance,
  containmentRatio,
  sanitizeId,
} from './utils.js'

const classifyOcrRole = ({
  text,
}: {
  text: string
}): OcrBlockRole => {
  const compact = text.replace(/\s+/g, '')

  if (/^[0-9:：./\\-]+$/.test(compact)) return 'numeric'
  if (/^[0-9]+[a-zA-Z\u4e00-\u9fa5]?$/.test(compact)) return 'numeric'
  return 'paragraph'
}

const assignContainerId = ({
  box,
  containers,
}: {
  box: Box
  containers: ContainerRecord[]
}) => {
  const containing = containers
    .filter((container) => containmentRatio(box, container.box) >= 0.65)
    .sort((left, right) => areaOf(left.box) - areaOf(right.box))

  if (containing[0]) return containing[0].id

  return (
    [...containers].sort(
      (left, right) =>
        boxCenterDistance(box, left.box) - boxCenterDistance(box, right.box),
    )[0]?.id ?? null
  )
}

const flattenOcrBlocks = ({
  ocr,
  semanticContainers,
}: {
  ocr: OcrResult
  semanticContainers: ContainerRecord[]
}) => {
  const blocks: OcrBlockRecord[] = []

  ocr.observations.forEach((observation) => {
    observation.lines.forEach((line, index) => {
      const text = line.text.trim()
      if (!text) return

      const bbox: Box = {
        height: line.boundingBox.height,
        width: line.boundingBox.width,
        x: line.boundingBox.x,
        y: line.boundingBox.y,
      }
      const id = `ocr-${sanitizeId(`${observation.id}-${index + 1}-${text}`)}`

      blocks.push({
        assignedContainerId: assignContainerId({
          box: bbox,
          containers: semanticContainers,
        }),
        assignedNodeId: null,
        bbox,
        confidence: line.confidence,
        id,
        observationId: observation.id,
        role: classifyOcrRole({ text }),
        text,
      })
    })
  })

  return blocks
}

export { flattenOcrBlocks }
