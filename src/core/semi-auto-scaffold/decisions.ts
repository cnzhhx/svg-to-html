import type { ContainerLayoutReport } from '../container-layout/types.js'
import { resolveSvgDesign } from '../design-resolve.js';
import type {
  StructureDraft,
} from './types.js'

const createScaffoldDecisionsMarkdown = ({
  containerLayout,
  design,
  structureDraft,
}: {
  containerLayout: ContainerLayoutReport
  design: Awaited<ReturnType<typeof resolveSvgDesign>>
  structureDraft: StructureDraft
}) => {
  const lines = [
    '# Scaffold Decisions',
    '',
    `- design: ${design.designName}`,
    `- topLevelNodes: ${structureDraft.topLevelNodeIds.length}`,
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
    '## Asset Usage Rules',
    '- 普通 UI 文本必须用 HTML 真实文本替代（font-family + font-size + color）。',
    '- 不要把原始 SVG、整页、整模块或大区域裁片作为最终视觉层。',
    '',
  ]

  return `${lines.join('\n')}\n`
}

export { createScaffoldDecisionsMarkdown }
