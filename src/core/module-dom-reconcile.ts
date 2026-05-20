import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { readJsonIfExists } from './io.js'
import {
  resolveArtifactDir,
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  writeJsonFile,
  writeTextFile,
} from './utils.js'

type ModuleDomReconcileIssue = {
  kind: string
  message: string
  moduleId?: string
  severity: 'info' | 'warning'
}

type ModuleDomReconcileReport = {
  duplicateDomModuleIds: string[]
  domModuleCount: number
  domModuleIds: string[]
  issueCount: number
  issues: ModuleDomReconcileIssue[]
  missingDomModuleIds: string[]
  passed: boolean
  planModuleCount: number
  planModuleIds: string[]
  unplannedDomModuleIds: string[]
}

type ModuleDomReconcileArtifacts = {
  jsonPath: string
  markdownPath: string
  report: ModuleDomReconcileReport
}

type ModulePlanShape = {
  modules?: Array<{ id?: string }> | Record<string, unknown>
}

const unique = (items: string[]) => [...new Set(items)]

const readPlanModuleIds = async (modulePlanPath: string) => {
  const plan = await readJsonIfExists<ModulePlanShape>(modulePlanPath)
  if (!plan?.modules) return []

  if (Array.isArray(plan.modules)) {
    return plan.modules
      .map((module) => module.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }

  if (typeof plan.modules === 'object') {
    return Object.keys(plan.modules).sort((left, right) => left.localeCompare(right))
  }

  return []
}

const extractDesignModuleIds = (html: string) => {
  const ids: string[] = []
  const sectionMatches = html.matchAll(/<section\b[^>]*>/gi)
  for (const match of sectionMatches) {
    const tag = match[0]
    const classMatch = tag.match(/\bclass=(["'])(.*?)\1/i)
    if (!classMatch?.[2]?.split(/\s+/).includes('design-module')) continue

    const idMatch = tag.match(/\bdata-module-id=(["'])(.*?)\1/i)
    if (idMatch?.[2]) ids.push(idMatch[2])
  }
  return ids
}

const findDuplicates = (items: string[]) => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of items) {
    if (seen.has(item)) {
      duplicates.add(item)
    } else {
      seen.add(item)
    }
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right))
}

const createMarkdown = (report: ModuleDomReconcileReport) => [
  '# Module DOM Reconcile',
  '',
  `- passed: ${report.passed}`,
  `- plan modules: ${report.planModuleCount}`,
  `- DOM modules: ${report.domModuleCount}`,
  `- unplanned DOM modules: ${report.unplannedDomModuleIds.length}`,
  `- missing DOM modules: ${report.missingDomModuleIds.length}`,
  `- duplicate DOM modules: ${report.duplicateDomModuleIds.length}`,
  '',
  '## Issues',
  '',
  ...(report.issues.length
    ? report.issues.map((issue) =>
        `- [${issue.severity}] ${issue.kind}${issue.moduleId ? ` ${issue.moduleId}` : ''}: ${issue.message}`,
      )
    : ['- none']),
  '',
  '## IDs',
  '',
  `- plan: ${report.planModuleIds.join(', ') || 'none'}`,
  `- dom: ${report.domModuleIds.join(', ') || 'none'}`,
  '',
].join('\n')

const createModuleDomReconcileReport = async ({
  artifactDir: customArtifactDir,
  htmlPath,
  inputPath,
  modulePlanPath,
  scale,
}: {
  artifactDir?: string
  htmlPath?: string
  inputPath: string
  modulePlanPath?: string
  scale?: number
}): Promise<ModuleDomReconcileArtifacts> => {
  const resolvedDesign = htmlPath
    ? await resolveSvgDesign(inputPath, { scale })
    : await resolveDesignPair(inputPath, { scale })
  const design = htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : resolvedDesign
  const artifactDir = await resolveArtifactDir(design.svgPath, customArtifactDir)
  const resolvedModulePlanPath =
    modulePlanPath ?? path.join(artifactDir, 'modules', 'module-plan.json')
  const planModuleIds = unique(await readPlanModuleIds(resolvedModulePlanPath))
  const html = await readFile(design.htmlPath, 'utf8')
  const domModuleIdsRaw = extractDesignModuleIds(html)
  const domModuleIds = unique(domModuleIdsRaw)
  const planSet = new Set(planModuleIds)
  const domSet = new Set(domModuleIds)
  const unplannedDomModuleIds = domModuleIds.filter((id) => !planSet.has(id))
  const missingDomModuleIds = planModuleIds.filter((id) => !domSet.has(id))
  const duplicateDomModuleIds = findDuplicates(domModuleIdsRaw)
  const issues: ModuleDomReconcileIssue[] = []

  unplannedDomModuleIds.forEach((moduleId) => {
    issues.push({
      kind: 'unplanned-dom-module',
      message:
        'Final HTML contains a design-module that was not present in module-plan.json. This may be a controller-agent rescue region; verify ownership manually.',
      moduleId,
      severity: 'warning',
    })
  })

  missingDomModuleIds.forEach((moduleId) => {
    issues.push({
      kind: 'missing-planned-module',
      message: 'A planned module id is not present as a top-level design-module in final HTML.',
      moduleId,
      severity: 'warning',
    })
  })

  duplicateDomModuleIds.forEach((moduleId) => {
    issues.push({
      kind: 'duplicate-dom-module',
      message: 'A design-module id appears more than once in final HTML.',
      moduleId,
      severity: 'warning',
    })
  })

  const report: ModuleDomReconcileReport = {
    duplicateDomModuleIds,
    domModuleCount: domModuleIds.length,
    domModuleIds,
    issueCount: issues.length,
    issues,
    missingDomModuleIds,
    passed: missingDomModuleIds.length === 0 && duplicateDomModuleIds.length === 0,
    planModuleCount: planModuleIds.length,
    planModuleIds,
    unplannedDomModuleIds,
  }

  const jsonPath = path.join(artifactDir, 'modules', 'module-dom-reconcile.json')
  const markdownPath = path.join(artifactDir, 'modules', 'module-dom-reconcile.md')
  await writeJsonFile(jsonPath, report)
  await writeTextFile(markdownPath, createMarkdown(report))

  return {
    jsonPath,
    markdownPath,
    report,
  }
}

export type {
  ModuleDomReconcileArtifacts,
  ModuleDomReconcileIssue,
  ModuleDomReconcileReport,
}
export { createModuleDomReconcileReport }
