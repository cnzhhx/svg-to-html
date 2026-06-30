import type { Request, Response } from 'express'
import { Router } from 'express'

import { sessionStore, type SessionEvent } from '../session-store.js'
import type { Session } from '../session-store.js'

const router = Router()

const isBrokenPipeError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'EPIPE' || error.code === 'ECONNRESET')

const isFrontendMessage = (
  message: Session['messages'][number],
) => Boolean(message)

const sessionForEventStream = (session: Session): Session => ({
  ...session,
  logs: [],
  messages: session.messages.filter(isFrontendMessage),
})

const isFrontendAgentEvent = (event: Record<string, unknown>) => {
  const eventType = event['type']
  if (
    eventType === 'thread.started' ||
    eventType === 'turn.started' ||
    eventType === 'turn.completed' ||
    eventType === 'turn.failed'
  ) {
    return true
  }
  if (
    eventType !== 'item.started' &&
    eventType !== 'item.updated' &&
    eventType !== 'item.completed'
  ) {
    return false
  }

  const item = event['item']
  if (!item || typeof item !== 'object') return false
  const itemType = (item as Record<string, unknown>)['type']
  return (
    itemType === 'agent_message' ||
    itemType === 'command_execution' ||
    itemType === 'error' ||
    itemType === 'mcp_tool_call' ||
    itemType === 'reasoning'
  )
}

const shouldPushEventToFrontend = (event: SessionEvent) => {
  if (event.type === 'user-message:queued') return false
  if (event.type === 'agent:event') return isFrontendAgentEvent(event.event)
  if (event.type === 'message') return isFrontendMessage(event.message)
  return true
}

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
    if (!shouldPushEventToFrontend(event)) return
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

  sessionStore.on(`session:${sessionId}`, listener)

  if (!writeEventStream('retry: 3000\n')) return
  const initSession = sessionStore.get(sessionId) ?? session
  if (
    !writeEventStream(
      `data: ${JSON.stringify({
        type: 'init',
        session: sessionForEventStream(initSession),
        timestamp: Date.now(),
      })}\n\n`,
    )
  ) {
    return
  }

  heartbeat = setInterval(() => {
    writeEventStream(': keepalive\n\n')
  }, 15000)
})

export default router
