import path from 'node:path'

import { readModulePlan } from '../pipeline/module-merge.js'
import { verifyModuleLocal } from '../pipeline/agent-runner/module-local-verify.js'
import {
  normalizePlanModules,
  parseCliFlags,
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

const parseArgs = (args: string[]) => {
  const { flags } = parseCliFlags(args, VALUE_FLAGS)
  return {
    moduleDir: flags.get('--module-dir') ?? flags.get('--moduleDir') ?? '.',
    moduleId: flags.get('--module-id') ?? flags.get('--moduleId'),
    modulePlanPath:
      flags.get('--module-plan') ?? flags.get('--modulePlan') ?? '../module-plan.json',
    moduleSvgPath:
      flags.get('--module-svg') ?? flags.get('--moduleSvg') ?? 'module.svg',
    round: Number(flags.get('--round') ?? '0'),
    scale: flags.get('--scale') ? Number(flags.get('--scale')) : undefined,
    scaffoldHtmlPath:
      flags.get('--scaffold') ??
      flags.get('--scaffold-html') ??
      flags.get('--scaffoldHtml') ??
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
