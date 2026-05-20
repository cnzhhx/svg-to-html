import type { EventEmitter } from 'node:events'

import type { Session, SessionEvent } from './types.js'

const MAX_SESSION_LOG_CHARS = Number(process.env['SESSION_LOG_MAX_CHARS'] ?? 12000)
const MAX_SESSION_LOG_ENTRIES = Number(
  process.env['SESSION_LOG_MAX_ENTRIES'] ?? 500,
)
const MAX_CODEX_EVENT_OUTPUT_CHARS = Number(
  process.env['SESSION_CODEX_EVENT_OUTPUT_MAX_CHARS'] ?? 6000,
)

const truncateText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
}

const stringifyError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const isCodexReasoningEvent = (event: Record<string, unknown>) => {
  const item = event['item']
  return (
    Boolean(item) &&
    typeof item === 'object' &&
    (item as Record<string, unknown>)['type'] === 'reasoning'
  )
}

const sanitizeCodexEvent = (event: Record<string, unknown>) => {
  const item = event['item']
  if (!item || typeof item !== 'object') return event

  const itemRecord = item as Record<string, unknown>
  const aggregatedOutput = itemRecord['aggregated_output']
  if (typeof aggregatedOutput !== 'string') return event

  return {
    ...event,
    item: {
      ...itemRecord,
      aggregated_output: truncateText(
        aggregatedOutput,
        MAX_CODEX_EVENT_OUTPUT_CHARS,
      ),
    },
  }
}

const sanitizeSessionEvent = (event: SessionEvent): SessionEvent => {
  if (event.type === 'codex:event') {
    return {
      ...event,
      event: sanitizeCodexEvent(event.event),
    }
  }
  return event
}

const getSessionEventId = (event: SessionEvent) =>
  'sessionId' in event ? event.sessionId : event.session.id

const emitSessionEvent = (
  emitter: EventEmitter,
  sessions: Map<string, Session>,
  persistence: { persistEvent(session: Session, event: SessionEvent): void },
  event: SessionEvent,
) => {
  const sanitizedEvent = sanitizeSessionEvent(event)
  const sessionId = getSessionEventId(sanitizedEvent)
  const session = sessions.get(sessionId)
  if (session) {
    persistence.persistEvent(session, sanitizedEvent)
  }
  emitter.emit(`session:${sessionId}`, sanitizedEvent)
  emitter.emit('session:*', sanitizedEvent)
}

export {
  MAX_SESSION_LOG_CHARS,
  MAX_SESSION_LOG_ENTRIES,
  emitSessionEvent,
  isCodexReasoningEvent,
  sanitizeSessionEvent,
  stringifyError,
  truncateText,
}
