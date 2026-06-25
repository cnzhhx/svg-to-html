import { createContainerLayoutReport } from '../core/container-layout/index.js'
import { parseFlagValue } from './cli-utils.js'

const parseScale = (args: string[]) => {
  if (args.includes('--scale') && args.indexOf('--scale') === args.length - 1) {
    throw new Error('Missing value for --scale')
  }
  const raw = parseFlagValue(args, '--scale')
  if (raw === undefined) return undefined
  const scale = Number(raw)
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid value for --scale: ${raw} (expected a positive number)`)
  }
  return scale
}

const main = async () => {
  const args = process.argv.slice(2)
  const inputPath = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '--scale')
  const scale = parseScale(args)

  if (!inputPath) {
    throw new Error(
      'Usage: pnpm exec tsx src/cli/resolve-container-layout.ts 设计稿.svg路径 [--scale 1]',
    )
  }

  console.log('[container-layout] Reading SVG layout...')
  const result = await createContainerLayoutReport({ inputPath, scale })

  console.log('[container-layout] Report written:')
  console.log(`- JSON: ${result.outputPath}`)
  console.log(`- Markdown: ${result.markdownPath}`)
  console.log(`- Containers found: ${result.report.containers.length}`)
  console.log(`- Pattern hints: ${result.report.patterns.length}`)
  console.log(`- SVG nodes: ${result.svgNodeCount}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
