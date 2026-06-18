import path from 'node:path'
import os from 'node:os'
import { mkdir, readFile } from 'node:fs/promises'

import express from 'express'

import { detectBrowserBinary } from './core/cdp.js'
import { setWorkspaceRoot } from './core/paths.js'
import { processQueuedSessions } from './pipeline/agent-runner/index.js'
import componentLibrariesRouter from './routes/component-libraries.js'
import eventsRouter from './routes/events.js'
import jobRouter from './routes/job.js'
import uploadRouter from './routes/upload.js'
import { sessionStore } from './session-store.js'

const isExpectedConnectionCloseError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'EPIPE' || error.code === 'ECONNRESET')

process.on('unhandledRejection', (reason) => {
  if (isExpectedConnectionCloseError(reason)) return
  console.error('[fatal] unhandledRejection:', reason)
})

process.on('uncaughtException', (error) => {
  if (isExpectedConnectionCloseError(error)) return
  console.error('[fatal] uncaughtException:', error)
  process.exit(1)
})

const PORT = Number(process.env['PORT'] ?? 80)
const WORKSPACE = path.resolve(process.env['WORKSPACE'] ?? path.join(process.cwd(), 'workspace'))
const BASE_PATH = '/transformer'
const BUILD_TIME = new Date().toISOString()
const INDEX_HTML_PATH = path.resolve(process.cwd(), 'public/index.html')

// Initialize workspace root
setWorkspaceRoot(WORKSPACE)

const app = express()

const handleHealth = (_req: express.Request, res: express.Response) => {
  res.status(200).type('text/plain').send('ok')
}

// Mount business routes under BASE_PATH
const router = express.Router()

router.all('/health', handleHealth)

router.use(express.json())

// API routes
router.use('/api', uploadRouter)
router.use('/api', componentLibrariesRouter)
router.use('/api', jobRouter)
router.use('/api', eventsRouter)

// Serve workspace files (SVGs, HTMLs, PNGs, etc.). These artifacts are often
// overwritten in place during repair/verify loops, so keep browser caches out.
router.use(
  '/files',
  express.static(WORKSPACE, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store')
    },
  }),
)

const serveIndexHtml = async (_req: express.Request, res: express.Response) => {
  const template = await readFile(INDEX_HTML_PATH, 'utf8')
  res
    .status(200)
    .type('html')
    .send(template.replace('__BUILD_TIME__', BUILD_TIME))
}

router.get('/', serveIndexHtml)
router.get('/index.html', serveIndexHtml)

// Serve frontend
router.use(express.static(path.resolve(process.cwd(), 'public')))

app.use(BASE_PATH, router)

const main = async () => {
  await mkdir(WORKSPACE, { recursive: true })
  await sessionStore.hydrateFromDisk()
  processQueuedSessions()

  app.listen(PORT, () => {
    const browserBinary = detectBrowserBinary()

    console.log(`Design-to-HTML service running at http://localhost:${PORT}${BASE_PATH || '/'}`)
    console.log(`Base Path: ${BASE_PATH || '(none)'}`)
    console.log(`Workspace: ${WORKSPACE}`)
    console.log(`Platform: ${process.platform} ${os.release()}`)
    console.log(`Node: ${process.version}`)
    console.log(`Browser Binary: ${browserBinary ?? 'NOT FOUND'}`)
    console.log(`Build Time: ${BUILD_TIME}`)
  })
}

main().catch((error) => {
  const browserBinary = detectBrowserBinary()
  const message = error instanceof Error ? error.message : String(error)

  console.error('Failed to start service')
  console.error(`Workspace: ${WORKSPACE}`)
  console.error(`Browser Binary: ${browserBinary ?? 'NOT FOUND'}`)
  console.error(message)
  if (/EACCES|permission denied/i.test(message) && PORT === 80) {
    console.error('Port 80 需要更高权限；请使用 sudo 启动，或改用 PORT 环境变量指定其他端口。')
  }
  process.exitCode = 1
})
