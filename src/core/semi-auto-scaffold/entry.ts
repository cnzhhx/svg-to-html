import path from 'node:path'

import {
  createContainerLayoutReport,
} from '../container-layout/entry.js'
import type { ContainerLayoutReport } from '../container-layout/types.js'
import type { SvgLayoutResult } from '../svg-layout.js'
import { resolveArtifactDir } from '../paths.js'
import { resolveSvgDesign } from '../design-resolve.js'
import { writeJsonFile, writeTextFile } from '../file-io.js'
import { createScaffoldDecisionsMarkdown } from './decisions.js'
import { createHtmlScaffoldFromDraft } from './html-renderer.js'
import { buildStructureDraft } from './structure-draft.js'
import type { SemiAutoScaffoldResult } from './types.js'

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

  const structureDraft = buildStructureDraft({
    containerLayout,
  })

  const structureDraftPath = path.join(artifactDir, 'structure-draft.json')
  const scaffoldDecisionsPath = path.join(artifactDir, 'scaffold-decisions.md')

  await writeJsonFile(structureDraftPath, structureDraft)
  await writeTextFile(
    scaffoldDecisionsPath,
    createScaffoldDecisionsMarkdown({
      containerLayout,
      design,
      structureDraft,
    }),
  )

  const htmlScaffold = createHtmlScaffoldFromDraft({
    artifactPaths: {
      scaffoldDecisionsPath,
      structureDraftPath,
    },
    design,
    structureDraft,
  })

  return {
    artifactDir,
    htmlScaffold,
    scaffoldDecisionsPath,
    structureDraft,
    structureDraftPath,
  }
}

export { buildSemiAutoScaffoldArtifacts }
