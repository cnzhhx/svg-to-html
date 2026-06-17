import path from 'node:path'

import {
  createContainerLayoutReport,
} from './container-layout.js'
import type { ContainerLayoutReport } from './container-layout/types.js'
import type { SvgLayoutResult } from './svg-layout.js'
import {
  resolveArtifactDir,
  resolveSvgDesign,
  writeJsonFile,
  writeTextFile,
} from './utils.js'
import { createScaffoldDecisionsMarkdown } from './semi-auto-scaffold/decisions.js'
import { createHtmlScaffoldFromDraft } from './semi-auto-scaffold/html-renderer.js'
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
