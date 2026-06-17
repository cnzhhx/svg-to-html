import path from 'node:path'

import { readModulePlan } from '../pipeline/module-merge.js'
import { verifyModuleLocal } from '../pipeline/agent-runner/module-local-verify.js'
import {
  normalizePlanModules,
  resolveRequiredPath,
} from './cli-utils.js'

const VALUE_FLAGS = new Set([
  '--module-dir',
  '--moduleDir',
  '--module-id',
  '--moduleId',
  '--module-plan',
  '--modulePlan',
  '--module-svg',
  '--moduleSvg',
  '--round',
  '--scale',
  '--scaffold',
  '--scaffold-html',
  '--scaffoldHtml',
])

const INLINE_PREFIXES = [...VALUE_FLAGS].map((flag) => `${flag}=`)

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue

    const inlinePrefix = INLINE_PREFIXES.find((prefix) =>
      arg.startsWith(prefix),
    )
    if (inlinePrefix) {
      const value = arg.slice(inlinePrefix.length)
      if (!value) throw new Error(`Missing value for ${inlinePrefix.slice(0, -1)}`)
      values.set(inlinePrefix.slice(0, -1), value)
      continue
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`)
      values.set(arg, value)
      index += 1
      continue
    }
  }
  return {
    moduleDir: values.get('--module-dir') ?? values.get('--moduleDir') ?? '.',
    moduleId: values.get('--module-id') ?? values.get('--moduleId'),
    modulePlanPath:
      values.get('--module-plan') ?? values.get('--modulePlan') ?? '../module-plan.json',
    moduleSvgPath:
      values.get('--module-svg') ?? values.get('--moduleSvg') ?? 'module.svg',
    round: Number(values.get('--round') ?? '0'),
    scale: values.get('--scale') ? Number(values.get('--scale')) : undefined,
    scaffoldHtmlPath:
      values.get('--scaffold') ??
      values.get('--scaffold-html') ??
      values.get('--scaffoldHtml') ??
      '../modules-scaffold.html',
  }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (
    args.scale !== undefined &&
    (!Number.isFinite(args.scale) || args.scale <= 0)
  ) {
    throw new Error(
      `Invalid value for --scale: ${args.scale} (expected a positive number)`,
    )
  }
  const moduleDir = path.resolve(args.moduleDir)
  const moduleId = args.moduleId ?? path.basename(moduleDir)
  const modulePlanPath = resolveRequiredPath(
    args.modulePlanPath,
    moduleDir,
    'module plan',
  )
  const scaffoldHtmlPath = resolveRequiredPath(
    args.scaffoldHtmlPath,
    moduleDir,
    'scaffold HTML',
  )
  const moduleSvgPath = resolveRequiredPath(
    args.moduleSvgPath,
    moduleDir,
    'module SVG',
  )
  const modulePlan = await readModulePlan(modulePlanPath)
  const module = normalizePlanModules(modulePlan.modules).find(
    (candidate) => candidate.id === moduleId,
  )
  if (!module?.region) {
    throw new Error(
      `Module region not found in ${modulePlanPath}: ${moduleId}`,
    )
  }

  const result = await verifyModuleLocal({
    module: {
      id: moduleId,
      region: {
        height: module.region.height,
        id: module.region.id ?? moduleId,
        width: module.region.width,
        x: module.region.x,
        y: module.region.y,
      },
    },
    moduleDir,
    modulePlan,
    modulePlanPath,
    moduleSvgPath,
    onProgress: () => {},
    round: Number.isFinite(args.round) ? args.round : 0,
    scale: args.scale,
    scaffoldHtmlPath,
  })

  console.log(
    JSON.stringify({
      diffRatio: result.diffRatio,
      passed: result.passed,
    }),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
