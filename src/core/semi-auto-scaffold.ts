import path from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  createContainerLayoutReport,
  type ContainerLayoutReport,
} from './container-layout.js'
import { getOcrProvider, type OcrResult, runOcr } from './ocr.js'
import type { SvgLayoutResult } from './svg-layout.js'
import {
  resolveArtifactDir,
  resolveSvgDesign,
  writeJsonFile,
  writeTextFile,
} from './utils.js'
import { createScaffoldDecisionsMarkdown } from './semi-auto-scaffold/decisions.js'
import { createHtmlScaffoldFromDraft } from './semi-auto-scaffold/html-renderer.js'
import { flattenOcrBlocks } from './semi-auto-scaffold/ocr-blocks.js'
import { createShellManifest } from './semi-auto-scaffold/shell-manifest.js'
import { renderSvgToPng } from './semi-auto-scaffold/svg-render.js'
import { buildStructureDraft } from './semi-auto-scaffold/structure-draft.js'
import type { SemiAutoScaffoldResult } from './semi-auto-scaffold/types.js'

const buildSemiAutoScaffoldArtifacts = async ({
  containerLayoutReport,
  inputPath,
  scale,
  svgLayoutReport,
}: {
  containerLayoutReport?: ContainerLayoutReport
  inputPath: string
  scale?: number
  svgLayoutReport?: SvgLayoutResult
}): Promise<SemiAutoScaffoldResult> => {
  const design = await resolveSvgDesign(inputPath, { scale })
  const artifactDir = await resolveArtifactDir(design.svgPath)
  const containerLayout =
    containerLayoutReport ??
    (
      await createContainerLayoutReport({
        artifactDir,
        inputPath: design.svgPath,
        scale,
        svgLayout: svgLayoutReport,
      })
    ).report

  const svgPngPath = await renderSvgToPng({
    artifactDir,
    design,
  })
  const svgOcrPath = path.join(artifactDir, 'svg-ocr.json')
  await runOcr({
    imagePath: svgPngPath,
    outputPath: svgOcrPath,
  })

  const ocrResult = JSON.parse(
    await readFile(svgOcrPath, 'utf8'),
  ) as OcrResult
  const ocrBlocks = flattenOcrBlocks({
    ocr: ocrResult,
    semanticContainers: containerLayout.containers,
  })
  const shellManifest = await createShellManifest({
    containerLayout,
  })
  const structureDraft = buildStructureDraft({
    containerLayout,
    ocrBlocks,
    shellManifest,
  })

  const ocrBlocksPath = path.join(artifactDir, 'ocr-blocks.json')
  const structureDraftPath = path.join(artifactDir, 'structure-draft.json')
  const shellManifestPath = path.join(artifactDir, 'shell-manifest.json')
  const scaffoldDecisionsPath = path.join(artifactDir, 'scaffold-decisions.md')

  await writeJsonFile(ocrBlocksPath, {
    blockCount: ocrBlocks.length,
    blocks: ocrBlocks,
    designName: design.designName,
    fullText: ocrResult.fullText,
    imagePath: svgPngPath,
    provider: getOcrProvider(),
  })
  await writeJsonFile(structureDraftPath, structureDraft)
  await writeJsonFile(shellManifestPath, {
    designName: design.designName,
    entries: shellManifest,
  })
  await writeTextFile(
    scaffoldDecisionsPath,
    createScaffoldDecisionsMarkdown({
      containerLayout,
      design,
      ocrBlocks,
      shellManifest,
      structureDraft,
    }),
  )

  const htmlScaffold = createHtmlScaffoldFromDraft({
    artifactPaths: {
      ocrBlocksPath,
      scaffoldDecisionsPath,
      shellManifestPath,
      structureDraftPath,
    },
    design,
    ocrBlocks,
    shellManifest,
    structureDraft,
  })

  return {
    artifactDir,
    htmlScaffold,
    ocrBlocks,
    ocrBlocksPath,
    scaffoldDecisionsPath,
    shellManifest,
    shellManifestPath,
    structureDraft,
    structureDraftPath,
  }
}

export type {
  OcrBlockRecord,
  SemiAutoScaffoldResult,
  ShellManifestEntry,
  StructureDraft,
  StructureDraftNode,
} from './semi-auto-scaffold/types.js'
export { buildSemiAutoScaffoldArtifacts }
