import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  createAdaptiveModulePlan,
  type CreateAdaptiveModulePlanOptions,
  type ModulePlanMode,
  type ModulePlannerMode,
} from '../core/svg-vertical-modules.js'

const VALUE_FLAGS = new Set([
  '--artifact-dir',
  '--concurrency-limit',
  '--container-layout',
  '--min-gap',
  '--mode',
  // Deprecated no-op kept so old commands do not treat its value as inputPath.
  '--max-modules',
  '--ocr-blocks',
  '--planner',
  '--planner-retries',
  '--scale',
  '--shell-manifest',
  // Deprecated no-op kept so old commands do not treat its value as inputPath.
  '--target-module-count',
])

const parseFlagValue = (args: string[], flag: string) => {
  const inlineArg = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inlineArg) return inlineArg.slice(flag.length + 1)

  const flagIndex = args.indexOf(flag)
  if (flagIndex >= 0) return args[flagIndex + 1]

  return undefined
}

const parseNumberFlag = ({
  args,
  defaultValue,
  flag,
}: {
  args: string[]
  defaultValue?: number
  flag: string
}) => {
  const value = parseFlagValue(args, flag)
  if (value === undefined) return defaultValue
  return Number(value)
}

const parseMode = (args: string[]): ModulePlanMode => {
  const value = parseFlagValue(args, '--mode')
  if (!value) return 'auto'
  if (value === 'auto' || value === 'single' || value === 'vertical') {
    return value
  }
  throw new Error(`Invalid --mode value: ${value}`)
}

const parsePlanner = (args: string[]): ModulePlannerMode => {
  const value = parseFlagValue(args, '--planner')
  if (!value) return 'auto'
  if (value === 'auto' || value === 'script' || value === 'codex') {
    return value
  }
  throw new Error(`Invalid --planner value: ${value}`)
}

const parseInputPath = (args: string[]) =>
  args.find((arg, index) => {
    if (arg.startsWith('-')) return false
    return !VALUE_FLAGS.has(args[index - 1] ?? '')
  })

const readJsonFlag = async <T>(args: string[], flag: string) => {
  const filePath = parseFlagValue(args, flag)
  if (!filePath) return undefined

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
  return JSON.parse(await readFile(absolutePath, 'utf8')) as T
}

const usage =
  'Usage: pnpm exec tsx src/cli/split-svg-modules.ts 设计稿.svg路径 [--mode auto|single|vertical] [--planner auto|script|codex] [--planner-retries 2] [--min-gap 10] [--concurrency-limit 20] [--scale 1|2] [--container-layout artifacts/container-layout.json] [--ocr-blocks artifacts/ocr-blocks.json] [--shell-manifest artifacts/shell-manifest.json]'

const main = async () => {
  const args = process.argv.slice(2)
  const inputPath = parseInputPath(args)
  const minGap = parseNumberFlag({ args, defaultValue: 10, flag: '--min-gap' })
  const mode = parseMode(args)
  const planner = parsePlanner(args)
  const plannerRetries = parseNumberFlag({
    args,
    defaultValue: 2,
    flag: '--planner-retries',
  })
  const artifactDir = parseFlagValue(args, '--artifact-dir')
  if (args.includes('--scale') && args.indexOf('--scale') === args.length - 1) {
    throw new Error('Missing value for --scale')
  }
  const scale = parseNumberFlag({
    args,
    defaultValue: 1,
    flag: '--scale',
  })
  const concurrencyLimit = parseNumberFlag({
    args,
    defaultValue: Number(process.env['MAX_PARALLEL_MODULE_AGENTS'] ?? 20),
    flag: '--concurrency-limit',
  })

  if (
    !inputPath ||
    !Number.isFinite(minGap) ||
    (minGap ?? 0) <= 0 ||
    !Number.isFinite(concurrencyLimit) ||
    (concurrencyLimit ?? 0) <= 0 ||
    !Number.isFinite(plannerRetries) ||
    (plannerRetries ?? 0) < 0 ||
    !Number.isFinite(scale) ||
    (scale ?? 0) <= 0
  ) {
    throw new Error(usage)
  }

  console.log('[svg-modules] Planning adaptive modules...')
  const result = await createAdaptiveModulePlan({
    artifactDir,
    concurrencyLimit,
    containerLayoutReport: await readJsonFlag<
      CreateAdaptiveModulePlanOptions['containerLayoutReport']
    >(args, '--container-layout'),
    inputPath,
    minGap,
    mode,
    ocrBlocks: await readJsonFlag<CreateAdaptiveModulePlanOptions['ocrBlocks']>(
      args,
      '--ocr-blocks',
    ),
    planner,
    plannerRetries,
    scale,
    shellManifest: await readJsonFlag<
      CreateAdaptiveModulePlanOptions['shellManifest']
    >(args, '--shell-manifest'),
  })

  console.log('[svg-modules] Plan written:')
  console.log(`- JSON: ${result.jsonPath}`)
  console.log(`- Markdown: ${result.markdownPath}`)
  console.log(`- Regions: ${result.regionsPath}`)
  console.log(`- Diff regions: ${result.diffRegionsPath}`)
  console.log(
    `- Route: ${result.report.mode}, modules: ${result.report.modules.length}, selected gaps: ${result.report.gaps.filter((gap) => gap.selected).length}`,
  )
  console.log(
    `- Planner: ${result.report.planner?.selected ?? 'unknown'} (requested: ${result.report.planner?.requested ?? planner}, modelAttempted: ${result.report.planner?.modelAttempted ?? false})`,
  )
  if (result.report.planner?.fallbackReason) {
    console.log(`- Planner fallback: ${result.report.planner.fallbackReason}`)
  }
  if (result.report.planner?.validation) {
    console.log(
      `- Planner validation: passed=${result.report.planner.validation.passed}, errors=${result.report.planner.validation.errorCount}, warnings=${result.report.planner.validation.warningCount}`,
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
