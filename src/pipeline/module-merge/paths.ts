import path from 'node:path'

import { toAbsolutePath } from '../../core/utils.js'
import type { ModuleMergeOptions, ModulePlan } from './types.js'
import { resolveConfiguredPath } from './utils.js'

const resolveModulePlanPath = ({ artifactDir, modulePlanPath }: ModuleMergeOptions) => {
  if (modulePlanPath) return toAbsolutePath(modulePlanPath)
  if (!artifactDir) {
    throw new Error('module merge requires either artifactDir or modulePlanPath')
  }
  return path.join(toAbsolutePath(artifactDir), 'modules', 'module-plan.json')
}

const resolveOutputHtmlPath = ({
  modulePlan,
  outputHtmlPath,
  planDir,
}: {
  modulePlan: ModulePlan
  outputHtmlPath?: string
  planDir: string
}) => {
  const configuredPath =
    outputHtmlPath ??
    modulePlan.outputHtmlPath ??
    modulePlan.finalHtmlPath ??
    modulePlan.htmlPath

  if (!configuredPath) {
    throw new Error(
      'module merge requires outputHtmlPath, or outputHtmlPath/finalHtmlPath/htmlPath in module-plan.json',
    )
  }

  return resolveConfiguredPath(configuredPath, planDir)
}

const resolveScaffoldHtmlPath = ({
  modulePlan,
  outputHtmlPath,
  planDir,
  scaffoldHtmlPath,
}: {
  modulePlan: ModulePlan
  outputHtmlPath: string
  planDir: string
  scaffoldHtmlPath?: string
}) => {
  const configuredPath =
    scaffoldHtmlPath ??
    modulePlan.scaffoldHtmlPath ??
    modulePlan.baseHtmlPath

  return configuredPath
    ? resolveConfiguredPath(configuredPath, planDir)
    : outputHtmlPath
}

export { resolveModulePlanPath, resolveOutputHtmlPath, resolveScaffoldHtmlPath }
