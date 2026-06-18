import type { EventEmitter } from 'node:events'

import { truncate } from '../core/string-utils.js'
import {
  MAX_AGENT_EVENT_OUTPUT_CHARS,
  MAX_AGENT_REASONING_EVENT_CHARS,
  MAX_SESSION_LOG_CHARS,
  MAX_SESSION_LOG_ENTRIES,
} from '../config/index.js'
import type { Session, SessionEvent } from './types.js'

const truncateText = (value: string, maxChars: number) =>
  truncate(value, maxChars, (v, m) => `\n[truncated ${v.length - m} chars]`)

const sampleText = (value: string, maxChars: number) => {
  if (maxChars <= 0) return ''
  return value.length <= maxChars ? value : value.slice(0, maxChars)
}

const sampleUnknown = (value: unknown, maxChars: number) => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return sampleText(value, maxChars)
  try {
    return sampleText(JSON.stringify(value), maxChars)
  } catch {
    return sampleText(String(value), maxChars)
  }
}

const stringifyError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const sanitizeAgentEvent = (event: Record<string, unknown>) => {
  const eventType = event['type']
  const nextEvent = { ...event }
  if (eventType === 'turn.failed') {
    const error = event['error']
    if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>
      nextEvent['error'] = {
        ...errorRecord,
        ...(typeof errorRecord['message'] === 'string'
          ? {
              message: sampleText(
                errorRecord['message'],
                MAX_AGENT_EVENT_OUTPUT_CHARS,
              ),
            }
          : {}),
      }
    }
  }
  if (eventType === 'error' && typeof event['message'] === 'string') {
    nextEvent['message'] = sampleText(
      event['message'],
      MAX_AGENT_EVENT_OUTPUT_CHARS,
    )
  }

  const item = event['item']
  if (!item || typeof item !== 'object') return nextEvent

  const itemRecord = item as Record<string, unknown>
  const itemType = itemRecord['type']
  const aggregatedOutput = itemRecord['aggregated_output']
  const command = itemRecord['command']
  const server = itemRecord['server']
  const tool = itemRecord['tool']
  const error = itemRecord['error']
  const result = itemRecord['result']
  const nextItem = { ...itemRecord }

  if (itemType === 'reasoning' && typeof itemRecord['text'] === 'string') {
    nextItem['text'] = sampleText(
      itemRecord['text'],
      MAX_AGENT_REASONING_EVENT_CHARS,
    )
  }

  if (itemType === 'error' && typeof itemRecord['message'] === 'string') {
    nextItem['message'] = sampleText(
      itemRecord['message'],
      MAX_AGENT_EVENT_OUTPUT_CHARS,
    )
  }

  if (itemType === 'command_execution') {
    if (typeof command === 'string') {
      nextItem['command'] = sampleText(command, MAX_AGENT_EVENT_OUTPUT_CHARS)
    }
    if (typeof aggregatedOutput === 'string') {
      nextItem['aggregated_output'] = sampleText(
        aggregatedOutput,
        MAX_AGENT_EVENT_OUTPUT_CHARS,
      )
    }
  }

  if (itemType === 'mcp_tool_call') {
    if (typeof server === 'string') {
      nextItem['server'] = sampleText(server, MAX_AGENT_EVENT_OUTPUT_CHARS)
    }
    if (typeof tool === 'string') {
      nextItem['tool'] = sampleText(tool, MAX_AGENT_EVENT_OUTPUT_CHARS)
    }
    if (error && typeof error === 'object') {
      const errorRecord = error as Record<string, unknown>
      nextItem['error'] = {
        ...errorRecord,
        ...(typeof errorRecord['message'] === 'string'
          ? {
              message: sampleText(
                errorRecord['message'],
                MAX_AGENT_EVENT_OUTPUT_CHARS,
              ),
            }
          : {}),
      }
    }
    if (result !== undefined) {
      nextItem['result'] = sampleUnknown(result, MAX_AGENT_EVENT_OUTPUT_CHARS)
    }
  }

  if (itemType === 'todo_list' && Array.isArray(itemRecord['items'])) {
    nextItem['items'] = itemRecord['items'].slice(0, 20).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const entryRecord = entry as Record<string, unknown>
      return {
        ...entryRecord,
        ...(typeof entryRecord['text'] === 'string'
          ? {
              text: sampleText(
                entryRecord['text'],
                MAX_AGENT_EVENT_OUTPUT_CHARS,
              ),
            }
          : {}),
      }
    })
  }

  if (itemType === 'file_change' && Array.isArray(itemRecord['changes'])) {
    nextItem['changes'] = itemRecord['changes'].slice(0, 50).map((change) => {
      if (!change || typeof change !== 'object') return change
      const changeRecord = change as Record<string, unknown>
      return {
        ...changeRecord,
        ...(typeof changeRecord['path'] === 'string'
          ? {
              path: sampleText(
                changeRecord['path'],
                MAX_AGENT_EVENT_OUTPUT_CHARS,
              ),
            }
          : {}),
      }
    })
  }

  if (itemType === 'web_search' && typeof itemRecord['query'] === 'string') {
    nextItem['query'] = sampleText(
      itemRecord['query'],
      MAX_AGENT_EVENT_OUTPUT_CHARS,
    )
  }

  return { ...nextEvent, item: nextItem }
}

const sanitizeSessionEvent = (event: SessionEvent): SessionEvent => {
  if (event.type === 'agent:event') {
    return {
      ...event,
      event: sanitizeAgentEvent(event.event),
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
  stringifyError,
  truncateText,
}
