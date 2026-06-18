import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import {
  STATIC_SERVER_POOL_DISABLED,
  STATIC_SERVER_POOL_IDLE_MS,
} from '../config/runtime.js'
import { getWorkspaceRoot, isInsidePath } from './utils.js'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
}

const WORKSPACE_URL_PREFIX = '/__workspace'

type StaticServer = {
  close: () => Promise<void>
  origin: string
}

type StaticServerProcess = StaticServer & {
  closed: boolean
  rootDir: string
  server: http.Server
}

let pooledServer: StaticServerProcess | null = null
let pooledServerStarting: Promise<StaticServerProcess> | null = null
let pooledServerRefCount = 0
let pooledServerIdleTimer: ReturnType<typeof setTimeout> | null = null

const clearPooledServerIdleTimer = () => {
  if (!pooledServerIdleTimer) return
  clearTimeout(pooledServerIdleTimer)
  pooledServerIdleTimer = null
}

const startStaticServerProcess = async (
  rootDir: string,
): Promise<StaticServerProcess> => {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(requestUrl.pathname)
      const isWorkspaceRequest =
        pathname === WORKSPACE_URL_PREFIX || pathname.startsWith(`${WORKSPACE_URL_PREFIX}/`)
      const baseDir = isWorkspaceRequest ? getWorkspaceRoot() : rootDir
      const requestPath = isWorkspaceRequest
        ? pathname.slice(WORKSPACE_URL_PREFIX.length) || '/'
        : pathname
      const relativePath = requestPath === '/' ? '/index.html' : requestPath
      const absolutePath = path.resolve(baseDir, `.${relativePath}`)

      if (!isInsidePath(baseDir, absolutePath)) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }

      const fileStat = await stat(absolutePath)
      const targetPath = fileStat.isDirectory()
        ? path.join(absolutePath, 'index.html')
        : absolutePath

      const buffer = await readFile(targetPath)
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type':
          MIME_TYPES[path.extname(targetPath).toLowerCase()] ??
          'application/octet-stream',
      })
      response.end(buffer)
    } catch {
      response.writeHead(404)
      response.end('Not Found')
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to start static server')

  const serverProcess: StaticServerProcess = {
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (serverProcess.closed) {
          resolve()
          return
        }
        serverProcess.closed = true
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    closed: false,
    origin: `http://127.0.0.1:${address.port}`,
    rootDir,
    server,
  }
  server.once('close', () => {
    serverProcess.closed = true
  })
  return serverProcess
}

const getPooledStaticServer = async (rootDir: string) => {
  clearPooledServerIdleTimer()
  if (pooledServer && !pooledServer.closed && pooledServer.rootDir === rootDir) {
    return pooledServer
  }
  if (pooledServer && pooledServer.rootDir !== rootDir) {
    const previous = pooledServer
    pooledServer = null
    await previous.close()
  }

  if (!pooledServerStarting) {
    pooledServerStarting = startStaticServerProcess(rootDir)
      .then((server) => {
        pooledServer = server
        server.server.once('close', () => {
          if (pooledServer === server) pooledServer = null
          pooledServerRefCount = 0
          clearPooledServerIdleTimer()
        })
        return server
      })
      .finally(() => {
        pooledServerStarting = null
      })
  }

  return pooledServerStarting
}

const releasePooledStaticServer = async (server: StaticServerProcess) => {
  if (pooledServerRefCount > 0 || pooledServer !== server) return
  clearPooledServerIdleTimer()

  if (STATIC_SERVER_POOL_IDLE_MS === 0) {
    pooledServer = null
    await server.close()
    return
  }

  pooledServerIdleTimer = setTimeout(() => {
    pooledServerIdleTimer = null
    if (pooledServerRefCount > 0 || pooledServer !== server) return
    pooledServer = null
    void server.close()
  }, STATIC_SERVER_POOL_IDLE_MS)
}

const shutdownStaticServerPool = async () => {
  clearPooledServerIdleTimer()
  const starting = pooledServerStarting
  const server = pooledServer
  pooledServer = null
  pooledServerRefCount = 0

  const startedServer = starting ? await starting.catch(() => null) : null
  await Promise.allSettled(
    [server, startedServer]
      .filter((item): item is StaticServerProcess => Boolean(item))
      .filter((item, index, items) => items.indexOf(item) === index)
      .map((item) => item.close()),
  )
}

const startStaticServer = async (): Promise<StaticServer> => {
  const rootDir = path.resolve(process.cwd())
  if (STATIC_SERVER_POOL_DISABLED) {
    const server = await startStaticServerProcess(rootDir)
    return {
      close: server.close,
      origin: server.origin,
    }
  }

  const server = await getPooledStaticServer(rootDir)
  pooledServerRefCount += 1
  let released = false

  return {
    close: async () => {
      if (released) return
      released = true
      pooledServerRefCount = Math.max(0, pooledServerRefCount - 1)
      await releasePooledStaticServer(server)
    },
    origin: server.origin,
  }
}

export { startStaticServer, shutdownStaticServerPool }
