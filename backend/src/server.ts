import path from 'node:path'
import os from 'node:os'
import { readFile } from 'node:fs/promises'

import express from 'express'

import { assertCoreAvailable, getCoreServiceUrl } from './core-service/client.js'
import jobsRouter from './routes/jobs.js'
import { getBackendConfig } from './config/index.js'

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

const PORT = getBackendConfig().server.port
const FRONTEND_PUBLIC_DIR = path.resolve(process.cwd(), '../frontend/public')
const BASE_PATH = '/transformer'
const BUILD_TIME = new Date().toISOString()
const INDEX_HTML_PATH = path.join(FRONTEND_PUBLIC_DIR, 'index.html')

const app = express()

const handleHealth = (_req: express.Request, res: express.Response) => {
  res.status(200).type('text/plain').send('ok')
}

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end()
})

// Mount business routes under BASE_PATH
const router = express.Router()

router.all('/health', handleHealth)

router.use(express.json())

// API routes
router.use('/api', jobsRouter)

const serveIndexHtml = async (_req: express.Request, res: express.Response) => {
  const template = await readFile(INDEX_HTML_PATH, 'utf8')
  res
    .status(200)
    .type('html')
    .send(template.replace('__BUILD_TIME__', BUILD_TIME))
}

router.get('/', serveIndexHtml)
router.get('/index.html', serveIndexHtml)
router.get('/favicon.ico', (_req, res) => {
  res.status(204).end()
})

// Serve frontend
router.use(express.static(FRONTEND_PUBLIC_DIR))

app.use(BASE_PATH, router)

const main = async () => {
  await assertCoreAvailable()

  app.listen(PORT, () => {
    console.log(`Design-to-HTML gateway running at http://localhost:${PORT}${BASE_PATH || '/'}`)
    console.log(`Base Path: ${BASE_PATH || '(none)'}`)
    console.log(`SVG Transform Core: ${getCoreServiceUrl()}`)
    console.log(`Platform: ${process.platform} ${os.release()}`)
    console.log(`Node: ${process.version}`)
    console.log(`Build Time: ${BUILD_TIME}`)
  })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)

  console.error('Failed to start service')
  console.error(`SVG_TRANSFORM_CORE_URL: ${getBackendConfig().core.serviceUrl || '(not configured)'}`)
  console.error(message)
  if (/EACCES|permission denied/i.test(message) && PORT === 80) {
    console.error('Port 80 需要更高权限；请使用 sudo 启动，或改用 PORT 环境变量指定其他端口。')
  }
  process.exitCode = 1
})
