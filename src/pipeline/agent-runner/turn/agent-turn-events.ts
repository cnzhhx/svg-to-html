import { truncate } from '../../../core/string-utils.js'
import {
  getMaxAgentStdoutLogChars,
  getMaxAgentStdoutLogLineChars,
  getMaxAgentStdoutLogLines,
  getMaxEventCommandChars,
  getMaxEventCommandOutputChars,
  getMaxEventMetricChunkGaps,
  getMaxEventMetricThinkSamples,
  getMaxEventReasoningChars,
  getMaxEventToolTextChars,
  getMaxModelTelemetryRecords,
} from '../../../config/index.js'
import { sessionStore } from '../../../session-store.js'
import type {
  AgentThreadEvent,
  AgentThreadItem,
  AgentTurnMetrics,
} from '../../agent-runtime/index.js'

const truncateLine = (line: string) =>
  truncate(line, getMaxAgentStdoutLogLineChars(), '…')

const logCommandOutputPreview = (sessionId: string, output: string) => {
  const trimmed = output.trim()
  if (!trimmed) return

  const preview =
    trimmed.length > getMaxAgentStdoutLogChars()
      ? trimmed.slice(0, getMaxAgentStdoutLogChars())
      : trimmed
  const previewLines = preview.split(/\r?\n/).filter((line) => line.trim())
  const lines = previewLines.slice(0, getMaxAgentStdoutLogLines())

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

const truncateForEvent = (value: string, maxChars: number) =>
  truncate(value, maxChars, '')

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
    .map((value) => truncateForEvent(value, getMaxEventToolTextChars()))

const compactMetricsForSession = (
  metrics: AgentTurnMetrics,
): AgentTurnMetrics => {
  return {
    ...metrics,
    chunkGaps: metrics.chunkGaps.slice(0, getMaxEventMetricChunkGaps()),
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
          ).map((value) => truncateForEvent(value, getMaxEventToolTextChars())),
          retryEvents: compactStringArray(
            metrics.providerTelemetry.retryEvents,
            20,
          ),
          stderrTail:
            typeof metrics.providerTelemetry.stderrTail === 'string'
              ? truncateForEvent(
                  metrics.providerTelemetry.stderrTail,
                  getMaxEventToolTextChars(),
                )
              : metrics.providerTelemetry.stderrTail,
        }
      : undefined,
    thinkSamples: metrics.thinkSamples
      .slice(0, getMaxEventMetricThinkSamples())
      .map((sample) => ({
        ...sample,
        text: truncateForEvent(sample.text, getMaxEventToolTextChars()),
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
        command: truncateForEvent(event.item.command, getMaxEventCommandChars()),
        aggregated_output: event.item.aggregated_output
          ? truncateForEvent(
              event.item.aggregated_output,
              getMaxEventCommandOutputChars(),
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
        text: truncateForEvent(event.item.text, getMaxEventReasoningChars()),
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
          getMaxEventToolTextChars(),
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
        server: truncateForEvent(event.item.server, getMaxEventToolTextChars()),
        tool: truncateForEvent(event.item.tool, getMaxEventToolTextChars()),
        ...(event.item.filePath
          ? { filePath: truncateForEvent(event.item.filePath, getMaxEventToolTextChars()) }
          : {}),
        ...(event.item.error
          ? {
              error: {
                ...event.item.error,
                message: truncateForEvent(
                  event.item.error.message,
                  getMaxEventToolTextChars(),
                ),
              },
            }
          : {}),
        ...(event.item.result !== undefined
          ? {
              result: compactUnknownForEvent(
                event.item.result,
                getMaxEventToolTextChars(),
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
          getMaxEventToolTextChars(),
        ),
      },
    }
  }
  if (event.type === 'error') {
    return {
      ...event,
      message: truncateForEvent(event.message, getMaxEventToolTextChars()),
    }
  }
  return event
}

const persistModelTelemetry = (
  sessionId: string,
  metrics: AgentTurnMetrics,
) => {
  const maxModelTelemetryRecords = getMaxModelTelemetryRecords()
  if (maxModelTelemetryRecords <= 0) return
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
        ? truncateForEvent(metrics.firstTextSample, getMaxEventToolTextChars())
        : metrics.firstTextSample,
    firstThinkAt: metrics.firstThinkAt,
    firstThinkDelayMs: metrics.firstThinkDelayMs,
    firstThinkSample:
      typeof metrics.firstThinkSample === 'string'
        ? truncateForEvent(metrics.firstThinkSample, getMaxEventToolTextChars())
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

  const updatedRecords = previousRecords.length >= maxModelTelemetryRecords
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
        ? `[message] ${truncateForEvent(item.text, getMaxEventToolTextChars())}`
        : '[message]'
    case 'command_execution':
      return `[command:${item.status}] ${truncateForEvent(item.command, getMaxEventCommandChars())}`
    case 'mcp_tool_call':
      return `[mcp:${item.status}] ${truncateForEvent(item.server, getMaxEventToolTextChars())}/${truncateForEvent(item.tool, getMaxEventToolTextChars())}`
    case 'todo_list':
      return `[todo] ${item.items.map((entry) => `${entry.completed ? 'x' : '-'} ${truncateForEvent(entry.text, getMaxEventToolTextChars())}`).join(' | ')}`
    case 'error':
      return `[error] ${truncateForEvent(item.message, getMaxEventToolTextChars())}`
    case 'file_change':
      return `[file_change:${item.status}] ${item.changes.map((change) => `${change.kind}:${truncateForEvent(change.path, getMaxEventToolTextChars())}`).join(', ')}`
    case 'web_search':
      return `[web_search] ${truncateForEvent(item.query, getMaxEventToolTextChars())}`
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
            ? `, thinkSample="${truncateForEvent(metrics.firstThinkSample, getMaxEventToolTextChars())}"`
            : ''),
      )
      return
    }
    case 'turn.failed':
      sessionStore.addLog(
        sessionId,
        `[agent] turn failed: ${truncateForEvent(event.error.message, getMaxEventToolTextChars())}`,
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
            `[agent:running] ${truncateForEvent(event.item.command, getMaxEventCommandChars())}`,
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
        `[agent] stream error: ${truncateForEvent(event.message, getMaxEventToolTextChars())}`,
      )
      return
  }
}

export { logThreadEvent }
