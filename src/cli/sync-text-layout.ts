import { syncInlineTextLayoutFile } from '../core/text-layout.js'
import { toAbsolutePath } from '../core/utils.js'

const main = async () => {
  const [, , inputPath] = process.argv

  if (!inputPath) {
    throw new Error(
      'Usage: pnpm exec tsx src/cli/sync-text-layout.ts 还原页.html路径',
    )
  }

  const htmlPath = toAbsolutePath(inputPath)
  console.log(`[sync-text-layout] Syncing: ${htmlPath}`)
  await syncInlineTextLayoutFile(htmlPath)
  console.log('[sync-text-layout] Done')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
