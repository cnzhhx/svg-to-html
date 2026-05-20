import { sessionStore } from '../../session-store.js'
import type {
  AgentThreadEvent,
  AgentThreadItem,
} from '../agent-runtime/index.js'

const MAX_CODEX_STDOUT_LOG_CHARS = Number(
  process.env['SESSION_CODEX_STDOUT_LOG_CHARS'] ?? 10_000,
)
const MAX_CODEX_STDOUT_LOG_LINES = Number(
  process.env['SESSION_CODEX_STDOUT_LOG_LINES'] ?? 20,
)
const MAX_CODEX_STDOUT_LOG_LINE_CHARS = Number(
  process.env['SESSION_CODEX_STDOUT_LOG_LINE_CHARS'] ?? 1_000,
)

const truncateLine = (line: string) =>
  line.length > MAX_CODEX_STDOUT_LOG_LINE_CHARS
    ? `${line.slice(0, MAX_CODEX_STDOUT_LOG_LINE_CHARS)}…`
    : line

const logCommandOutputPreview = (sessionId: string, output: string) => {
  const trimmed = output.trim()
  if (!trimmed) return

  const preview =
    trimmed.length > MAX_CODEX_STDOUT_LOG_CHARS
      ? trimmed.slice(0, MAX_CODEX_STDOUT_LOG_CHARS)
      : trimmed
  const previewLines = preview.split(/\r?\n/).filter((line) => line.trim())
  const lines = previewLines.slice(0, MAX_CODEX_STDOUT_LOG_LINES)

  lines.forEach((line) => {
    sessionStore.addLog(sessionId, `[agent:stdout] ${truncateLine(line)}`)
  })

  if (trimmed.length > preview.length || previewLines.length > lines.length) {
    sessionStore.addLog(
      sessionId,
      `[agent:stdout] output omitted from session log (${trimmed.length} chars total)`,
    )
  }
}

const summarizeChecklistProgress = (
  item: Extract<AgentThreadItem, { type: 'todo_list' }>,
) => {
  const total = item.items.length
  const completed = item.items.filter((entry) => entry.completed).length
  const current = item.items.find((entry) => !entry.completed)?.text
  return {
    completed,
    current,
    total,
  }
}

const summarizeItem = (item: AgentThreadItem) => {
  switch (item.type) {
    case 'reasoning':
      return '[reasoning omitted]'
    case 'agent_message':
      return item.text ? `[message] ${item.text}` : '[message]'
    case 'command_execution':
      return `[command:${item.status}] ${item.command}`
    case 'mcp_tool_call':
      return `[mcp:${item.status}] ${item.server}/${item.tool}`
    case 'todo_list':
      return `[todo] ${item.items.map((entry) => `${entry.completed ? 'x' : '-'} ${entry.text}`).join(' | ')}`
    case 'error':
      return `[error] ${item.message}`
    case 'file_change':
      return `[file_change:${item.status}] ${item.changes.map((change) => `${change.kind}:${change.path}`).join(', ')}`
    case 'web_search':
      return `[web_search] ${item.query}`
    default:
      return '[item] unknown'
  }
}

const logThreadEvent = (
  sessionId: string,
  event: AgentThreadEvent,
  options: { updateSessionThread?: boolean } = {},
) => {
  const updateSessionThread = options.updateSessionThread ?? true
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    event.item.type === 'reasoning'
  ) {
    return
  }

  sessionStore.emitCodexEvent(
    sessionId,
    event as unknown as Record<string, unknown>,
  )

  switch (event.type) {
    case 'thread.started':
      if (updateSessionThread) {
        sessionStore.update(sessionId, { threadId: event.thread_id })
      }
      sessionStore.addLog(
        sessionId,
        `[agent] thread started: ${event.thread_id}`,
      )
      return
    case 'turn.started':
      sessionStore.addLog(sessionId, '[agent] turn started')
      return
    case 'turn.completed':
      sessionStore.addLog(
        sessionId,
        `[agent] turn completed: input=${event.usage.input_tokens}, output=${event.usage.output_tokens}`,
      )
      return
    case 'turn.failed':
      sessionStore.addLog(
        sessionId,
        `[agent] turn failed: ${event.error.message}`,
      )
      return
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      sessionStore.addLog(
        sessionId,
        `[agent] ${event.type} ${summarizeItem(event.item)}`,
      )
      if (event.item.type === 'todo_list') {
        const progress = summarizeChecklistProgress(event.item)
        sessionStore.addLog(
          sessionId,
          `[workflow] checklist ${progress.completed}/${progress.total}${
            progress.current ? `, current=${progress.current}` : ''
          }`,
        )
      }
      if (event.item.type === 'command_execution') {
        if (event.item.status === 'in_progress' && event.item.command) {
          sessionStore.addLog(
            sessionId,
            `[agent:running] ${event.item.command}`,
          )
        }
        if (
          event.item.status !== 'in_progress' &&
          event.item.aggregated_output
        ) {
          logCommandOutputPreview(sessionId, event.item.aggregated_output)
        }
      }
      return
    case 'error':
      sessionStore.addLog(sessionId, `[agent] stream error: ${event.message}`)
      return
  }
}

export { logThreadEvent }
