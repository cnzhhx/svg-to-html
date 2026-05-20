import type { ContainerLayoutReport } from '../container-layout/types.js'
import { getOcrProvider } from '../ocr.js'
import { resolveSvgDesign } from '../utils.js'
import type {
  OcrBlockRecord,
  ShellManifestEntry,
  StructureDraft,
} from './types.js'
import { sanitizeId } from './utils.js'

const createScaffoldDecisionsMarkdown = ({
  containerLayout,
  design,
  ocrBlocks,
  shellManifest,
  structureDraft,
}: {
  containerLayout: ContainerLayoutReport
  design: Awaited<ReturnType<typeof resolveSvgDesign>>
  ocrBlocks: OcrBlockRecord[]
  shellManifest: ShellManifestEntry[]
  structureDraft: StructureDraft
}) => {
  const ocrDrivenRefinements = ocrBlocks.filter(
    (block) =>
      block.assignedNodeId &&
      block.assignedContainerId &&
      !block.assignedNodeId.includes(sanitizeId(block.assignedContainerId)),
  )

  const unresolved = ocrBlocks.filter((block) => !block.assignedNodeId)

  const lines = [
    '# Scaffold Decisions',
    '',
    `- design: ${design.designName}`,
    `- ocrProvider: ${getOcrProvider()}`,
    `- ocrBlocks: ${ocrBlocks.length}`,
    `- topLevelNodes: ${structureDraft.topLevelNodeIds.length}`,
    `- shellAssets: ${shellManifest.length}`,
    `- shellAssetsReady: ${shellManifest.filter((entry) => entry.status === 'ready').length}`,
    '',
    '## SVG First-Pass Structure',
    ...(containerLayout.entryChildren.length
      ? [
          `- Entry children: ${containerLayout.entryChildren.join(', ')}`,
          `- Root children: ${containerLayout.rootChildren.join(', ')}`,
        ]
      : ['- Entry children: none']),
    ...(containerLayout.repeatedGroups.length
      ? containerLayout.repeatedGroups.map(
          (group) =>
            `- Repeated group: parent=${group.parentContainerId}, alignment=${group.alignment}, containers=${group.containerIds.join(', ')}`,
        )
      : ['- Repeated group: none']),
    '',
    '## OCR Block Assignment',
    ...ocrBlocks.slice(0, 24).map(
      (block) =>
        `- ${block.id}: "${block.text}" role=${block.role} container=${block.assignedContainerId ?? 'none'} node=${block.assignedNodeId ?? 'none'} confidence=${block.confidence}`,
    ),
    ...(ocrBlocks.length > 24 ? [`- ... ${ocrBlocks.length - 24} more OCR blocks omitted`] : []),
    '',
    '## OCR-Driven Refinements',
    ...(ocrDrivenRefinements.length
      ? ocrDrivenRefinements.map(
          (block) =>
            `- ${block.id}: OCR box landed in ${block.assignedContainerId}, but the draft places it in the more specific node ${block.assignedNodeId}.`,
        )
      : ['- none']),
    '',
    '## Shell Asset Decisions',
    ...(shellManifest.length
      ? shellManifest.map(
          (entry) => {
            const containsText =
              entry.containsText === true
                ? ' containsText=true'
                : entry.containsText === false
                  ? ' containsText=false'
                  : ''
            const overlapsOcrText = entry.overlapsOcrText
              ? ' overlapsOcrText=true'
              : ''
            const textTreatment = entry.textTreatment
              ? ` textTreatment=${entry.textTreatment}`
              : ''
            return `- ${entry.containerId}: status=${entry.status}, asset=${entry.assetName ?? 'none'}${containsText}${overlapsOcrText}${textTreatment}, reason=${entry.reason}`
          },
        )
      : ['- none']),
    '',
    '## Asset Usage Rules',
    '- 普通 UI 文本必须用 HTML 真实文本替代（font-family + font-size + color）。',
    '- manifest 标记为 mustUse 的静态资产按其 box/resolvedBox 与 fit 放置；如果图片里已有文字，不要再叠加重复 DOM 文本。',
    '- 不要把原始 SVG、整页、整模块或大区域裁片作为最终视觉层。',
    '',
    '## Open Items',
    ...(unresolved.length
      ? unresolved.map(
          (block) =>
            `- Unassigned OCR block: ${block.id} "${block.text}" @ (${block.bbox.x}, ${block.bbox.y}, ${block.bbox.width}x${block.bbox.height})`,
        )
      : ['- none']),
    '',
  ]

  return `${lines.join('\n')}\n`
}

export { createScaffoldDecisionsMarkdown }
