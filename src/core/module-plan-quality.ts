import path from 'node:path'

import { areaOf, intersectionArea } from './geometry.js'
import type { ModulePlannerMetadata } from './module-planner/types.js'
import {
  writeJsonFile,
  writeTextFile,
  type Box,
  type Region,
} from './utils.js'

type ModulePlanQualitySeverity = 'critical' | 'warning'

type ModulePlanQualityIssue = {
  details?: Record<string, unknown>
  kind: string
  message: string
  moduleId?: string
  relatedModuleIds?: string[]
  severity: ModulePlanQualitySeverity
}

type ModulePlanQualitySourceBox = {
  box: Box
  id: string
  kind: 'ocr' | 'shell'
}

type ModulePlanQualityModule = {
  candidateNodeCount?: number
  id: string
  nodePaths?: string[]
  ocrBlockIds?: string[]
  region: Region
  shellContainerIds?: string[]
}

type ModulePlanQualitySharedLayer = {
  id: string
  kind?: string
  nodePaths?: string[]
  region?: Region
}

type ModulePlanQualityInput = {
  artifactDir?: string
  concurrencyLimit?: number
  design: {
    height: number
    width: number
  }
  mode?: string
  modules: ModulePlanQualityModule[]
  ocrBlocks?: Array<{
    bbox?: Box
    id?: string
  }>
  planner?: ModulePlannerMetadata
  shellManifest?: Array<{
    box?: Box
    category?: string
    containerId?: string
    status?: string
  }>
  sharedLayers?: ModulePlanQualitySharedLayer[]
}

type ModulePlanQualityReport = {
  concurrency: {
    exceedsLimit: boolean
    limit: null | number
    moduleCount: number
  }
  coverage: {
    contentBottom: number
    moduleBottom: number
    sourceBoxCount: number
    uncoveredSourceBoxCount: number
    uncoveredSourceBoxIds: string[]
  }
  criticalIssueCount: number
  design: {
    height: number
    width: number
  }
  issueCount: number
  issues: ModulePlanQualityIssue[]
  mode?: string
  moduleCount: number
  overlap: {
    containingModuleCount: number
    pairCount: number
    pairs: Array<{
      intersectionArea: number
      moduleIds: [string, string]
      overlapOfSmaller: number
    }>
  }
  passed: boolean
  planner?: ModulePlannerMetadata
  sharedLayerCount: number
  warningIssueCount: number
}

type ModulePlanQualityArtifacts = {
  jsonPath: string
  markdownPath: string
  report: ModulePlanQualityReport
}

const round = (value: number, digits = 3) => Number(value.toFixed(digits))

const centerOf = (box: Box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

const pointInside = (point: { x: number; y: number }, box: Region) =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height

const bottomOf = (box: Pick<Box, 'height' | 'y'>) => box.y + box.height

const overlapLength = (
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) => Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart))

const isFiniteBox = (box: Box | undefined): box is Box =>
  Boolean(box) &&
  Number.isFinite(box?.x) &&
  Number.isFinite(box?.y) &&
  Number.isFinite(box?.width) &&
  Number.isFinite(box?.height) &&
  (box?.width ?? 0) > 0 &&
  (box?.height ?? 0) > 0

const clipBoxToViewport = (
  sourceBox: ModulePlanQualitySourceBox,
  viewport: Region,
): ModulePlanQualitySourceBox | null => {
  const x1 = Math.max(sourceBox.box.x, viewport.x)
  const y1 = Math.max(sourceBox.box.y, viewport.y)
  const x2 = Math.min(sourceBox.box.x + sourceBox.box.width, viewport.x + viewport.width)
  const y2 = Math.min(sourceBox.box.y + sourceBox.box.height, viewport.y + viewport.height)
  const width = x2 - x1
  const height = y2 - y1
  if (width <= 0 || height <= 0) return null

  return {
    ...sourceBox,
    box: {
      height,
      width,
      x: x1,
      y: y1,
    },
  }
}

const overlapOfSmaller = (left: Region, right: Region) => {
  const smallerArea = Math.min(areaOf(left), areaOf(right))
  if (smallerArea <= 0) return 0
  return intersectionArea(left, right) / smallerArea
}

const sourceBoxCoveredByModule = (
  sourceBox: ModulePlanQualitySourceBox,
  modules: ModulePlanQualityModule[],
) =>
  modules.some((module) => {
    const sourceArea = Math.max(1, areaOf(sourceBox.box))
    return (
      pointInside(centerOf(sourceBox.box), module.region) ||
      intersectionArea(sourceBox.box, module.region) / sourceArea >= 0.2
    )
  })

const hasCoveringRegion = ({
  modules,
  sharedLayers,
  viewport,
}: {
  modules: ModulePlanQualityModule[]
  sharedLayers: ModulePlanQualitySharedLayer[]
  viewport: Region
}) => {
  const viewportArea = Math.max(1, areaOf(viewport))
  const regions = [
    ...modules.map((module) => module.region),
    ...sharedLayers
      .filter((layer) => layer.kind === 'shared-underlay' && isFiniteBox(layer.region))
      .map((layer) => layer.region!),
  ]

  return regions.some((region) => {
    const coverage = intersectionArea(region, viewport) / viewportArea
    return (
      coverage >= 0.82 ||
      (region.width >= viewport.width * 0.9 &&
        region.height >= viewport.height * 0.75)
    )
  })
}

const isFlatVerticalStack = (modules: ModulePlanQualityModule[]) => {
  if (modules.length <= 1) return false

  for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
    const left = modules[leftIndex]!
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < modules.length;
      rightIndex += 1
    ) {
      const right = modules[rightIndex]!
      const verticalOverlap = overlapLength(
        left.region.y,
        bottomOf(left.region),
        right.region.y,
        bottomOf(right.region),
      )
      const smallerHeight = Math.max(
        1,
        Math.min(left.region.height, right.region.height),
      )
      if (verticalOverlap / smallerHeight > 0.25) return false
    }
  }

  return true
}

const collectVerticalCoverageGaps = ({
  modules,
  viewport,
}: {
  modules: ModulePlanQualityModule[]
  viewport: Region
}) => {
  const sorted = modules
    .map((module) => module.region)
    .sort((left, right) => left.y - right.y || left.x - right.x)
  const gaps: Array<{ fromY: number; height: number; toY: number }> = []
  let cursor = viewport.y

  sorted.forEach((region) => {
    if (region.y - cursor > 2) {
      gaps.push({
        fromY: round(cursor),
        height: round(region.y - cursor),
        toY: round(region.y),
      })
    }
    cursor = Math.max(cursor, bottomOf(region))
  })

  if (bottomOf(viewport) - cursor > 2) {
    gaps.push({
      fromY: round(cursor),
      height: round(bottomOf(viewport) - cursor),
      toY: round(bottomOf(viewport)),
    })
  }

  return gaps
}

const edgeCutsBox = (edgeY: number, box: Box) => {
  const inset = Math.min(8, Math.max(2, Math.min(box.width, box.height) * 0.18))
  return edgeY > box.y + inset && edgeY < bottomOf(box) - inset
}

const collectSourceBoxes = ({
  ocrBlocks = [],
  shellManifest = [],
}: Pick<ModulePlanQualityInput, 'ocrBlocks' | 'shellManifest'>) => {
  const ocrSourceBoxes = ocrBlocks.flatMap((block, index) => {
    if (!isFiniteBox(block.bbox)) return []
    return [
      {
        box: block.bbox,
        id: block.id ?? `ocr-${index + 1}`,
        kind: 'ocr' as const,
      },
    ]
  })

  const shellSourceBoxes = shellManifest.flatMap((entry, index) => {
    if (!isFiniteBox(entry.box)) return []
    if (entry.category?.toLowerCase() === 'layout') return []
    if (entry.status?.toLowerCase() === 'layout') return []
    return [
      {
        box: entry.box,
        id: entry.containerId ?? `shell-${index + 1}`,
        kind: 'shell' as const,
      },
    ]
  })

  return [...ocrSourceBoxes, ...shellSourceBoxes]
}

const createMarkdown = (report: ModulePlanQualityReport) => [
  '# Module Plan Quality',
  '',
  `- passed: ${report.passed}`,
  `- mode: ${report.mode ?? 'unknown'}`,
  report.planner
    ? `- planner: ${report.planner.selected} (requested: ${report.planner.requested}, modelAttempted: ${report.planner.modelAttempted})`
    : '- planner: unknown',
  report.planner?.fallbackReason
    ? `- planner fallback: ${report.planner.fallbackReason}`
    : undefined,
  report.planner?.validation
    ? `- planner validation: passed=${report.planner.validation.passed}, errors=${report.planner.validation.errorCount}, warnings=${report.planner.validation.warningCount}`
    : undefined,
  `- modules: ${report.moduleCount}`,
  `- shared layers: ${report.sharedLayerCount}`,
  `- design: ${report.design.width}x${report.design.height}`,
  `- critical issues: ${report.criticalIssueCount}`,
  `- warnings: ${report.warningIssueCount}`,
  `- source boxes: ${report.coverage.sourceBoxCount}`,
  `- uncovered source boxes: ${report.coverage.uncoveredSourceBoxCount}`,
  `- module bottom: ${report.coverage.moduleBottom}`,
  `- content bottom: ${report.coverage.contentBottom}`,
  report.concurrency.limit
    ? `- concurrency: ${report.concurrency.limit} (exceeds: ${report.concurrency.exceedsLimit})`
    : '- concurrency: not provided',
  '',
  '## Issues',
  '',
  ...(report.issues.length
    ? report.issues.map((issue) =>
        `- [${issue.severity}] ${issue.kind}${issue.moduleId ? ` ${issue.moduleId}` : ''}: ${issue.message}`,
      )
    : ['- none']),
  '',
  '## Overlap Pairs',
  '',
  ...(report.overlap.pairs.length
    ? report.overlap.pairs
        .slice(0, 20)
        .map(
          (pair) =>
            `- ${pair.moduleIds.join(' <-> ')}: overlapOfSmaller=${pair.overlapOfSmaller}, intersectionArea=${pair.intersectionArea}`,
        )
    : ['- none']),
  '',
]
  .filter((line): line is string => line !== undefined)
  .join('\n')

const createModulePlanQualityReport = async ({
  artifactDir,
  concurrencyLimit,
  design,
  mode,
  modules,
  ocrBlocks,
  planner,
  shellManifest,
  sharedLayers = [],
}: ModulePlanQualityInput): Promise<ModulePlanQualityArtifacts> => {
  const issues: ModulePlanQualityIssue[] = []
  const viewport = {
    height: design.height,
    width: design.width,
    x: 0,
    y: 0,
  }
  const sourceBoxes = collectSourceBoxes({ ocrBlocks, shellManifest })
    .map((sourceBox) => clipBoxToViewport(sourceBox, viewport))
    .filter((sourceBox): sourceBox is ModulePlanQualitySourceBox => Boolean(sourceBox))
  const uncoveredSourceBoxes = sourceBoxes.filter(
    (sourceBox) => !sourceBoxCoveredByModule(sourceBox, modules),
  )
  const moduleBottom = modules.length
    ? Math.max(...modules.map((module) => module.region.y + module.region.height))
    : 0
  const contentBottom = sourceBoxes.length
    ? Math.max(...sourceBoxes.map((sourceBox) => sourceBox.box.y + sourceBox.box.height))
    : 0

  if (uncoveredSourceBoxes.length > 0) {
    issues.push({
      details: {
        sampleIds: uncoveredSourceBoxes.slice(0, 20).map((sourceBox) => sourceBox.id),
      },
      kind: 'uncovered-source-content',
      message: `${uncoveredSourceBoxes.length} OCR/shell source box(es) are not covered by any module region.`,
      severity: 'critical',
    })
  }

  if (contentBottom - moduleBottom > 16) {
    issues.push({
      details: {
        contentBottom: round(contentBottom),
        moduleBottom: round(moduleBottom),
      },
      kind: 'content-below-last-module',
      message: `Source content extends ${round(contentBottom - moduleBottom)}px below the last module.`,
      severity: 'critical',
    })
  }

  const duplicateNodeOwners = new Map<string, string[]>()
  modules.forEach((module) => {
    ;(module.nodePaths ?? []).forEach((nodePath) => {
      const owners = duplicateNodeOwners.get(nodePath) ?? []
      owners.push(module.id)
      duplicateNodeOwners.set(nodePath, owners)
    })
  })
  const duplicateNodeOwnerSamples = [...duplicateNodeOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .slice(0, 20)
  if (duplicateNodeOwnerSamples.length > 0) {
    issues.push({
      details: {
        samples: duplicateNodeOwnerSamples.map(([nodePath, owners]) => ({
          nodePath,
          owners,
        })),
      },
      kind: 'node-owned-by-multiple-modules',
      message: `${duplicateNodeOwnerSamples.length} SVG node path(s) are owned by multiple semantic modules. Cross-module backgrounds should move to shared layers; ordinary nodes need a single owner.`,
      severity: 'critical',
    })
  }

  const hasFallbackCoverage = hasCoveringRegion({
    modules,
    sharedLayers,
    viewport,
  })
  if (!hasFallbackCoverage && isFlatVerticalStack(modules)) {
    const coverageGaps = collectVerticalCoverageGaps({ modules, viewport })
    if (coverageGaps.length > 0) {
      issues.push({
        details: {
          gaps: coverageGaps.slice(0, 20),
        },
        kind: 'no-fallback-region-gaps',
        message: `${coverageGaps.length} vertical module coverage gap(s) remain without a covering fallback/shared underlay layer.`,
        severity: 'critical',
      })
    }
  }

  const verticalEdges = modules.flatMap((module) => [
    {
      module,
      y: module.region.y,
    },
    {
      module,
      y: module.region.y + module.region.height,
    },
  ])
  const cutSourceSamples = verticalEdges.flatMap((edge) =>
    sourceBoxes
      .filter((sourceBox) => {
        const ownedByModule =
          sourceBox.kind === 'ocr'
            ? (edge.module.ocrBlockIds ?? []).includes(sourceBox.id)
            : (edge.module.shellContainerIds ?? []).includes(sourceBox.id)
        return ownedByModule && edgeCutsBox(edge.y, sourceBox.box)
      })
      .map((sourceBox) => ({
        boundaryY: round(edge.y),
        moduleId: edge.module.id,
        sourceBoxId: sourceBox.id,
        sourceKind: sourceBox.kind,
      })),
  )
  if (cutSourceSamples.length > 0) {
    issues.push({
      details: {
        samples: cutSourceSamples.slice(0, 20),
      },
      kind: 'module-boundary-cuts-source-box',
      message: `${cutSourceSamples.length} module boundary/source-box intersection(s) cut through OCR or shell source boxes.`,
      severity: 'critical',
    })
  }

  const overlapPairs: ModulePlanQualityReport['overlap']['pairs'] = []
  const containmentCountByModule = new Map<string, string[]>()
  for (let i = 0; i < modules.length; i++) {
    for (let j = i + 1; j < modules.length; j++) {
      const left = modules[i]!
      const right = modules[j]!
      const intersection = intersectionArea(left.region, right.region)
      if (intersection <= 0) continue
      const overlap = overlapOfSmaller(left.region, right.region)
      if (overlap >= 0.5) {
        overlapPairs.push({
          intersectionArea: round(intersection),
          moduleIds: [left.id, right.id],
          overlapOfSmaller: round(overlap),
        })
      }

      if (overlap < 0.95) continue
      const leftArea = areaOf(left.region)
      const rightArea = areaOf(right.region)
      const parent = leftArea >= rightArea ? left : right
      const child = parent === left ? right : left
      const contained = containmentCountByModule.get(parent.id) ?? []
      contained.push(child.id)
      containmentCountByModule.set(parent.id, contained)
    }
  }

  containmentCountByModule.forEach((containedIds, moduleId) => {
    if (containedIds.length < 3) return
    issues.push({
      details: {
        containedModuleIds: containedIds,
      },
      kind: 'parent-overlaps-child-modules',
      message: `Module overlaps ${containedIds.length} child-sized module region(s), which makes module-level diff ownership ambiguous.`,
      moduleId,
      relatedModuleIds: containedIds,
      severity: 'critical',
    })
  })

  const tinyModules = modules.filter(
    (module) =>
      (module.candidateNodeCount ?? 0) <= 1 &&
      (module.ocrBlockIds?.length ?? 0) <= 6 &&
      (module.shellContainerIds?.length ?? 0) <= 1,
  )
  if (tinyModules.length >= 4) {
    issues.push({
      details: {
        moduleIds: tinyModules.map((module) => module.id),
      },
      kind: 'many-tiny-modules',
      message: `${tinyModules.length} module(s) are very small; consider grouping adjacent repeated cards/rows to reduce agent overhead.`,
      severity: 'warning',
    })
  }

  const exceedsConcurrency =
    concurrencyLimit !== undefined && modules.length > concurrencyLimit
  if (exceedsConcurrency) {
    issues.push({
      details: {
        concurrencyLimit,
        moduleCount: modules.length,
      },
      kind: 'module-count-exceeds-concurrency',
      message: `Module count ${modules.length} exceeds concurrency ${concurrencyLimit}; agents will run in batches, not be skipped.`,
      severity: 'warning',
    })
  }

  const criticalIssueCount = issues.filter((issue) => issue.severity === 'critical').length
  const warningIssueCount = issues.filter((issue) => issue.severity === 'warning').length
  const report: ModulePlanQualityReport = {
    concurrency: {
      exceedsLimit: Boolean(exceedsConcurrency),
      limit: concurrencyLimit ?? null,
      moduleCount: modules.length,
    },
    coverage: {
      contentBottom: round(contentBottom),
      moduleBottom: round(moduleBottom),
      sourceBoxCount: sourceBoxes.length,
      uncoveredSourceBoxCount: uncoveredSourceBoxes.length,
      uncoveredSourceBoxIds: uncoveredSourceBoxes
        .slice(0, 50)
        .map((sourceBox) => sourceBox.id),
    },
    criticalIssueCount,
    design,
    issueCount: issues.length,
    issues,
    mode,
    moduleCount: modules.length,
    overlap: {
      containingModuleCount: [...containmentCountByModule.values()].filter(
        (containedIds) => containedIds.length >= 3,
      ).length,
      pairCount: overlapPairs.length,
      pairs: overlapPairs,
    },
    passed: criticalIssueCount === 0,
    planner,
    sharedLayerCount: sharedLayers.length,
    warningIssueCount,
  }

  const moduleDir = artifactDir
    ? path.join(artifactDir, 'modules')
    : process.cwd()
  const jsonPath = path.join(moduleDir, 'module-plan-quality.json')
  const markdownPath = path.join(moduleDir, 'module-plan-quality.md')
  await writeJsonFile(jsonPath, report)
  await writeTextFile(markdownPath, createMarkdown(report))

  return {
    jsonPath,
    markdownPath,
    report,
  }
}

export type {
  ModulePlanQualityArtifacts,
  ModulePlanQualityIssue,
  ModulePlanQualityReport,
}
export { createModulePlanQualityReport }
