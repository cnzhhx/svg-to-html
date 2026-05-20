import type { Request, Response } from 'express'
import { Router } from 'express'

import { sessionStore, type SessionEvent } from '../session-store.js'

const router = Router()

const isBrokenPipeError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'EPIPE' || error.code === 'ECONNRESET')

router.get('/sessions/:id/events', (req: Request, res: Response) => {
  const sessionId = String(req.params['id'] ?? '')
  const session = sessionStore.get(sessionId)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  req.socket.setKeepAlive(true)

  let closed = false
  let heartbeat: NodeJS.Timeout | undefined

  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    sessionStore.off(`session:${sessionId}`, listener)
  }

  const writeEventStream = (payload: string) => {
    if (
      closed ||
      req.destroyed ||
      res.destroyed ||
      res.writableEnded
    ) {
      cleanup()
      return false
    }

    try {
      res.write(payload)
      return true
    } catch (error) {
      if (isBrokenPipeError(error)) {
        cleanup()
        return false
      }
      throw error
    }
  }

  const listener = (event: SessionEvent) => {
    writeEventStream(`data: ${JSON.stringify(event)}\n\n`)
  }

  res.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      cleanup()
      return
    }
    throw error
  })
  req.on('aborted', cleanup)
  req.on('close', cleanup)

  if (!writeEventStream('retry: 3000\n')) return
  if (
    !writeEventStream(
      `data: ${JSON.stringify({
        type: 'init',
        session,
        timestamp: Date.now(),
      })}\n\n`,
    )
  ) {
    return
  }

  heartbeat = setInterval(() => {
    writeEventStream(': keepalive\n\n')
  }, 15000)

  sessionStore.on(`session:${sessionId}`, listener)
})

export default router
