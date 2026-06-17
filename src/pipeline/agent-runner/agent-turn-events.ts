import { sessionStore } from '../../session-store.js'
import type {
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurnMetrics,
} from '../agent-runtime/index.js'

const MAX_AGENT_STDOUT_LOG_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_CHARS'] ?? 100,
)
const MAX_AGENT_STDOUT_LOG_LINES = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINES'] ?? 20,
)
const MAX_AGENT_STDOUT_LOG_LINE_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINE_CHARS'] ?? 100,
)
const MAX_MODEL_TELEMETRY_RECORDS = Math.max(
  0,
  Number(process.env['SESSION_MODEL_TELEMETRY_RECORDS'] ?? 200),
)
const MAX_EVENT_COMMAND_OUTPUT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_OUTPUT_CHARS'] ?? 100),
)
const MAX_EVENT_COMMAND_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_CHARS'] ?? 100),
)
const MAX_EVENT_TOOL_TEXT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_TOOL_TEXT_CHARS'] ?? 100),
)
const MAX_EVENT_REASONING_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_REASONING_CHARS'] ?? 4_000),
)
const MAX_EVENT_METRIC_CHUNK_GAPS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_CHUNK_GAPS'] ?? 20),
)
const MAX_EVENT_METRIC_THINK_SAMPLES = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_THINK_SAMPLES'] ?? 0),
)

const truncateLine = (line: string) =>
  line.length > MAX_AGENT_STDOUT_LOG_LINE_CHARS
    ? `${line.slice(0, MAX_AGENT_STDOUT_LOG_LINE_CHARS)}…`
    : line

const logCommandOutputPreview = (sessionId: string, output: string) => {
  const trimmed = output.trim()
  if (!trimmed) return

  const preview =
    trimmed.length > MAX_AGENT_STDOUT_LOG_CHARS
      ? trimmed.slice(0, MAX_AGENT_STDOUT_LOG_CHARS)
      : trimmed
  const previewLines = preview.split(/\r?\n/).filter((line) => line.trim())
  const lines = previewLines.slice(0, MAX_AGENT_STDOUT_LOG_LINES)

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

const truncateForEvent = (value: string, maxChars: number) => {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars)
}

const compactUnknownForEvent = (value: unknown, maxChars: number) => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return truncateForEvent(value, maxChars)
  try {
    return truncateForEvent(JSON.stringify(value), maxChars)
  } catch {
    return truncateForEvent(String(value), maxChars)
  }
}

const compactStringArray = (values: string[], maxItems: number) =>
  values
    .slice(0, maxItems)
    .map((value) => truncateForEvent(value, MAX_EVENT_TOOL_TEXT_CHARS))

const compactMetricsForSession = (
  metrics: AgentTurnMetrics,
): AgentTurnMetrics => {
  return {
    ...metrics,
    chunkGaps: metrics.chunkGaps.slice(0, MAX_EVENT_METRIC_CHUNK_GAPS),
    providerTelemetry: metrics.providerTelemetry
      ? {
          ...metrics.providerTelemetry,
          errorBodies: compactStringArray(
            metrics.providerTelemetry.errorBodies,
            10,
          ),
          errorMessages: compactStringArray(
            metrics.providerTelemetry.errorMessages,
            20,
          ),
          providerRequestIds: metrics.providerTelemetry.providerRequestIds.slice(
            0,
            20,
          ).map((value) => truncateForEvent(value, MAX_EVENT_TOOL_TEXT_CHARS)),
          retryEvents: compactStringArray(
            metrics.providerTelemetry.retryEvents,
            20,
          ),
          stderrTail:
            typeof metrics.providerTelemetry.stderrTail === 'string'
              ? truncateForEvent(
                  metrics.providerTelemetry.stderrTail,
                  MAX_EVENT_TOOL_TEXT_CHARS,
                )
              : metrics.providerTelemetry.stderrTail,
        }
      : undefined,
    thinkSamples: metrics.thinkSamples
      .slice(0, MAX_EVENT_METRIC_THINK_SAMPLES)
      .map((sample) => ({
        ...sample,
        text: truncateForEvent(sample.text, MAX_EVENT_TOOL_TEXT_CHARS),
      })),
  }
}

const compactEventForSession = (event: AgentThreadEvent): AgentThreadEvent => {
  if (event.type === 'turn.metrics') {
    return {
      ...event,
      metrics: compactMetricsForSession(event.metrics),
    }
  }
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    event.item.type === 'command_execution'
  ) {
    return {
      ...event,
      item: {
        ...event.item,
        command: truncateForEvent(event.item.command, MAX_EVENT_COMMAND_CHARS),
        aggregated_output: event.item.aggregated_output
          ? truncateForEvent(
              event.item.aggregated_output,
              MAX_EVENT_COMMAND_OUTPUT_CHARS,
            )
          : event.item.aggregated_output,
      },
    }
  }
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    event.item.type === 'reasoning'
  ) {
    return {
      ...event,
      item: {
        ...event.item,
        text: truncateForEvent(event.item.text, MAX_EVENT_REASONING_CHARS),
      },
    }
  }
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    event.item.type === 'error'
  ) {
    return {
      ...event,
      item: {
        ...event.item,
        message: truncateForEvent(
          event.item.message,
          MAX_EVENT_TOOL_TEXT_CHARS,
        ),
      },
    }
  }
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    event.item.type === 'mcp_tool_call'
  ) {
    return {
      ...event,
      item: {
        ...event.item,
        server: truncateForEvent(event.item.server, MAX_EVENT_TOOL_TEXT_CHARS),
        tool: truncateForEvent(event.item.tool, MAX_EVENT_TOOL_TEXT_CHARS),
        ...(event.item.filePath
          ? { filePath: truncateForEvent(event.item.filePath, MAX_EVENT_TOOL_TEXT_CHARS) }
          : {}),
        ...(event.item.error
          ? {
              error: {
                ...event.item.error,
                message: truncateForEvent(
                  event.item.error.message,
                  MAX_EVENT_TOOL_TEXT_CHARS,
                ),
              },
            }
          : {}),
        ...(event.item.result !== undefined
          ? {
              result: compactUnknownForEvent(
                event.item.result,
                MAX_EVENT_TOOL_TEXT_CHARS,
              ),
            }
          : {}),
      },
    }
  }
  if (event.type === 'turn.failed') {
    return {
      ...event,
      error: {
        ...event.error,
        message: truncateForEvent(
          event.error.message,
          MAX_EVENT_TOOL_TEXT_CHARS,
        ),
      },
    }
  }
  if (event.type === 'error') {
    return {
      ...event,
      message: truncateForEvent(event.message, MAX_EVENT_TOOL_TEXT_CHARS),
    }
  }
  return event
}

const persistModelTelemetry = (
  sessionId: string,
  metrics: AgentTurnMetrics,
) => {
  if (MAX_MODEL_TELEMETRY_RECORDS <= 0) return
  const session = sessionStore.get(sessionId)
  if (!session) return

  const previousRecords = Array.isArray(session.result.modelTelemetryRecords)
    ? session.result.modelTelemetryRecords
    : []
  const record = {
    chunkGapCount: metrics.chunkGaps.length,
    completedAt: metrics.completedAt,
    durationMs: metrics.durationMs,
    firstTextAt: metrics.firstTextAt,
    firstTextDelayMs: metrics.firstTextDelayMs,
    firstTextSample:
      typeof metrics.firstTextSample === 'string'
        ? truncateForEvent(metrics.firstTextSample, MAX_EVENT_TOOL_TEXT_CHARS)
        : metrics.firstTextSample,
    firstThinkAt: metrics.firstThinkAt,
    firstThinkDelayMs: metrics.firstThinkDelayMs,
    firstThinkSample:
      typeof metrics.firstThinkSample === 'string'
        ? truncateForEvent(metrics.firstThinkSample, MAX_EVENT_TOOL_TEXT_CHARS)
        : metrics.firstThinkSample,
    maxChunkGapMs: metrics.maxChunkGapMs,
    providerTelemetry: metrics.providerTelemetry,
    runtimeTrace: metrics.runtimeTrace,
    runtimeTracePath: metrics.runtimeTracePath,
    source: metrics.source,
    startedAt: metrics.startedAt,
    textCharCount: metrics.textCharCount,
    textChunkCount: metrics.textChunkCount,
    thinkCharCount: metrics.thinkCharCount,
    thinkChunkCount: metrics.thinkChunkCount,
  }

  const updatedRecords = previousRecords.length >= MAX_MODEL_TELEMETRY_RECORDS
    ? [...previousRecords.slice(1), record]
    : [...previousRecords, record]

  sessionStore.update(sessionId, {
    result: {
      ...session.result,
      modelTelemetryRecords: updatedRecords,
    },
  })
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
      return item.text
        ? `[message] ${truncateForEvent(item.text, MAX_EVENT_TOOL_TEXT_CHARS)}`
        : '[message]'
    case 'command_execution':
      return `[command:${item.status}] ${truncateForEvent(item.command, MAX_EVENT_COMMAND_CHARS)}`
    case 'mcp_tool_call':
      return `[mcp:${item.status}] ${truncateForEvent(item.server, MAX_EVENT_TOOL_TEXT_CHARS)}/${truncateForEvent(item.tool, MAX_EVENT_TOOL_TEXT_CHARS)}`
    case 'todo_list':
      return `[todo] ${item.items.map((entry) => `${entry.completed ? 'x' : '-'} ${truncateForEvent(entry.text, MAX_EVENT_TOOL_TEXT_CHARS)}`).join(' | ')}`
    case 'error':
      return `[error] ${truncateForEvent(item.message, MAX_EVENT_TOOL_TEXT_CHARS)}`
    case 'file_change':
      return `[file_change:${item.status}] ${item.changes.map((change) => `${change.kind}:${truncateForEvent(change.path, MAX_EVENT_TOOL_TEXT_CHARS)}`).join(', ')}`
    case 'web_search':
      return `[web_search] ${truncateForEvent(item.query, MAX_EVENT_TOOL_TEXT_CHARS)}`
    default:
      return '[item] unknown'
  }
}

type LogThreadEventOptions = {
  eventSourceLabel?: string
  moduleId?: string
  updateSessionThread?: boolean
}

const compactEventWithSource = (
  event: AgentThreadEvent,
  options: LogThreadEventOptions,
) => {
  const compacted = compactEventForSession(event) as unknown as Record<
    string,
    unknown
  >
  const moduleId = options.moduleId?.trim()
  const sourceLabel = options.eventSourceLabel?.trim()
  if (!moduleId && !sourceLabel) return compacted

  const item = compacted['item']
  return {
    ...compacted,
    ...(moduleId ? { moduleId } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
    ...(item && typeof item === 'object'
      ? {
          item: {
            ...(item as Record<string, unknown>),
            ...(moduleId ? { moduleId } : {}),
            ...(sourceLabel ? { sourceLabel } : {}),
          },
        }
      : {}),
  }
}

const logThreadEvent = (
  sessionId: string,
  event: AgentThreadEvent,
  options: LogThreadEventOptions = {},
) => {
  const updateSessionThread = options.updateSessionThread ?? true

  sessionStore.emitAgentEvent(
    sessionId,
    compactEventWithSource(event, options),
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
        `[agent] turn completed: input=${event.usage.input_tokens}, cachedInput=${event.usage.cached_input_tokens ?? 0}, output=${event.usage.output_tokens}`,
      )
      return
    case 'turn.metrics': {
      const metrics = compactMetricsForSession(event.metrics)
      persistModelTelemetry(sessionId, metrics)
      const firstText =
        metrics.firstTextDelayMs === undefined
          ? 'n/a'
          : `${(metrics.firstTextDelayMs / 1000).toFixed(1)}s`
      const firstThink =
        metrics.firstThinkDelayMs === undefined
          ? 'n/a'
          : `${(metrics.firstThinkDelayMs / 1000).toFixed(1)}s`
      const maxChunkGap =
        metrics.maxChunkGapMs === undefined
          ? 'n/a'
          : `${(metrics.maxChunkGapMs / 1000).toFixed(1)}s`
      const telemetry = metrics.providerTelemetry
      const retrySummary =
        telemetry && telemetry.retryCount > 0
          ? `, retries=${telemetry.retryCount}`
          : ''
      const statusSummary =
        telemetry && telemetry.httpStatusCodes.length > 0
          ? `, httpStatus=${telemetry.httpStatusCodes.join('|')}`
          : ''
      const requestIdSummary =
        telemetry && telemetry.providerRequestIds.length > 0
          ? `, requestIds=${telemetry.providerRequestIds.slice(0, 3).join('|')}`
          : ''
      sessionStore.addLog(
        sessionId,
        `[agent:metrics] source=${metrics.source}, firstText=${firstText}, firstThink=${firstThink}, maxChunkGap=${maxChunkGap}, textChunks=${metrics.textChunkCount}, thinkChunks=${metrics.thinkChunkCount}, thinkChars=${metrics.thinkCharCount}, thinkSampleChars=${metrics.thinkSampleChars}` +
          retrySummary +
          statusSummary +
          requestIdSummary +
          (metrics.firstThinkSample
            ? `, thinkSample="${truncateForEvent(metrics.firstThinkSample, MAX_EVENT_TOOL_TEXT_CHARS)}"`
            : ''),
      )
      return
    }
    case 'turn.failed':
      sessionStore.addLog(
        sessionId,
        `[agent] turn failed: ${truncateForEvent(event.error.message, MAX_EVENT_TOOL_TEXT_CHARS)}`,
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
            `[agent:running] ${truncateForEvent(event.item.command, MAX_EVENT_COMMAND_CHARS)}`,
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
      sessionStore.addLog(
        sessionId,
        `[agent] stream error: ${truncateForEvent(event.message, MAX_EVENT_TOOL_TEXT_CHARS)}`,
      )
      return
  }
}

export { logThreadEvent }
