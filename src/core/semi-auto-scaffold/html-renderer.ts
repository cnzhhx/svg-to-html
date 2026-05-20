import path from 'node:path'

import { resolveSvgDesign, type Box } from '../utils.js'
import type {
  OcrBlockRecord,
  ShellManifestEntry,
  StructureDraft,
  StructureDraftNode,
} from './types.js'
import { escapeHtml, formatRem, sanitizeId } from './utils.js'

const getShellAssetPath = (shellEntry: ShellManifestEntry) =>
  shellEntry.assetKind === 'bitmap'
    ? shellEntry.assetPath ?? shellEntry.pngPath ?? shellEntry.svgPath
    : shellEntry.svgPath ?? shellEntry.assetPath ?? shellEntry.pngPath

const createShellEntryMap = (shellManifest: ShellManifestEntry[]) => {
  const shellByContainerId = new Map<string, ShellManifestEntry[]>()
  for (const entry of shellManifest) {
    const entries = shellByContainerId.get(entry.containerId) ?? []
    entries.push(entry)
    shellByContainerId.set(entry.containerId, entries)
  }
  return shellByContainerId
}

const renderNodeHtml = ({
  designHtmlDir,
  node,
  nodeById,
  ocrBlocksById,
  parentBox,
  shellByContainerId,
}: {
  designHtmlDir: string
  node: StructureDraftNode
  nodeById: Map<string, StructureDraftNode>
  ocrBlocksById: Map<string, OcrBlockRecord>
  parentBox: Box
  shellByContainerId: Map<string, ShellManifestEntry[]>
}) => {
  const left = node.box.x - parentBox.x
  const top = node.box.y - parentBox.y
  const style = [
    'position:absolute',
    `left:${formatRem(left)}`,
    `top:${formatRem(top)}`,
    `width:${formatRem(node.box.width)}`,
    `height:${formatRem(node.box.height)}`,
  ].join(';')

  const attrs = [
    `id="${node.id}"`,
    `data-draft-role="${node.role}"`,
    `style="${style}"`,
  ].join(' ')

  const children: string[] = []

  if (node.role === 'shell' && node.shellEntryId) {
    const shellEntries = shellByContainerId.get(node.shellEntryId) ?? []
    shellEntries.forEach((shellEntry, index) => {
      const shellPath = getShellAssetPath(shellEntry)
      if (!shellPath) return
      let relativeShellPath = path
        .relative(designHtmlDir, shellPath)
        .replaceAll(path.sep, '/')
      if (!relativeShellPath.startsWith('.')) relativeShellPath = `./${relativeShellPath}`
      const shellBox = shellEntry.assetBox ?? shellEntry.box ?? node.box
      const shellStyle = [
        'position:absolute',
        `left:${formatRem(shellBox.x - node.box.x)}`,
        `top:${formatRem(shellBox.y - node.box.y)}`,
        `width:${formatRem(shellBox.width)}`,
        `height:${formatRem(shellBox.height)}`,
        shellEntry.fit ? `object-fit:${shellEntry.fit}` : undefined,
      ].join(';')
      children.push(
        `<img class="draft-shell-asset" data-shell-asset="${index}" src="${relativeShellPath}" alt="" style="${shellStyle}" />`,
      )
    })
  }

  const textBlocks = node.textBlockIds
    .map((textBlockId) => ocrBlocksById.get(textBlockId))
    .filter((block): block is OcrBlockRecord => Boolean(block))
    .sort(
      (leftBlock, rightBlock) =>
        leftBlock.bbox.y - rightBlock.bbox.y ||
        leftBlock.bbox.x - rightBlock.bbox.x,
    )

  textBlocks.forEach((block) => {
    const textLeft = block.bbox.x - node.box.x
    const textTop = block.bbox.y - node.box.y
    const tag = block.role === 'paragraph' ? 'p' : 'span'
    const className = `draft-text draft-text--${block.role}`
    const textStyle = [
      'position:absolute',
      `left:${formatRem(textLeft)}`,
      `top:${formatRem(textTop)}`,
      `width:${formatRem(block.bbox.width)}`,
      `min-height:${formatRem(block.bbox.height)}`,
    ].join(';')
    children.push(
      `<${tag} id="text-${sanitizeId(block.id)}" class="${className}" style="${textStyle}">${escapeHtml(
        block.text,
      )}</${tag}>`,
    )
  })

  node.children.forEach((childId) => {
    const childNode = nodeById.get(childId)
    if (!childNode) return
    children.push(
      renderNodeHtml({
        designHtmlDir,
        node: childNode,
        nodeById,
        ocrBlocksById,
        parentBox: node.box,
        shellByContainerId,
      }),
    )
  })

  return `<${node.tag} ${attrs}>${children.join('')}</${node.tag}>`
}

const createHtmlScaffoldFromDraft = ({
  artifactPaths,
  design,
  ocrBlocks,
  shellManifest,
  structureDraft,
}: {
  artifactPaths: {
    ocrBlocksPath: string
    scaffoldDecisionsPath: string
    shellManifestPath: string
    structureDraftPath: string
  }
  design: Awaited<ReturnType<typeof resolveSvgDesign>>
  ocrBlocks: OcrBlockRecord[]
  shellManifest: ShellManifestEntry[]
  structureDraft: StructureDraft
}) => {
  const nodeById = new Map(
    structureDraft.nodes.map((node) => [node.id, node] as const),
  )
  const ocrBlocksById = new Map(
    ocrBlocks.map((block) => [block.id, block] as const),
  )
  const shellByContainerId = createShellEntryMap(shellManifest)
  const designHtmlDir = path.dirname(design.htmlPath)
  const rootBox: Box = {
    height: design.height,
    width: design.width,
    x: 0,
    y: 0,
  }

  const content = structureDraft.topLevelNodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is StructureDraftNode => Boolean(node))
    .map((node) =>
      renderNodeHtml({
        designHtmlDir,
        node,
        nodeById,
        ocrBlocksById,
        parentBox: rootBox,
        shellByContainerId,
      }),
    )
    .join('\n      ')

  const inlineConfig = JSON.stringify(
    {
      blocks: structureDraft.trackedBlocks,
      rules: [],
    },
    null,
    2,
  )

  const toRepoRelative = (value: string) =>
    path.relative(process.cwd(), value).replaceAll(path.sep, '/')

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${design.designName}</title>
    <style>
      :root {
        font-size: 100px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: #000;
        font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }

      .design-page {
        position: relative;
        width: ${formatRem(design.width)};
        height: ${formatRem(design.height)};
        overflow: hidden;
        background: #000;
      }

      .draft-shell-asset {
        display: block;
        width: 100%;
        height: 100%;
        pointer-events: none;
        user-select: none;
      }

      [data-draft-role="container"],
      [data-draft-role="group"],
      [data-draft-role="repeat-list"],
      [data-draft-role="repeat-item"],
      [data-draft-role="token-row"],
      [data-draft-role="token-cell"] {
        position: absolute;
      }

      .draft-text {
        margin: 0;
        line-height: 1.2;
        letter-spacing: 0;
        white-space: pre-wrap;
      }
    </style>
    <script type="application/json" data-text-layout-config>
${inlineConfig}
    </script>
  </head>
  <body>
    <main class="design-page">
      <!-- Semi-auto scaffold generated by generate-design.ts -->
      <!-- SVG geometry builds the initial structure; OCR text fills draft nodes and may justify later DOM regrouping. -->
      <!-- Artifacts: ${toRepoRelative(artifactPaths.ocrBlocksPath)}, ${toRepoRelative(
        artifactPaths.structureDraftPath,
      )}, ${toRepoRelative(artifactPaths.shellManifestPath)}, ${toRepoRelative(
        artifactPaths.scaffoldDecisionsPath,
      )} -->
      ${content}
    </main>
  </body>
</html>
`
}

export { createHtmlScaffoldFromDraft }
