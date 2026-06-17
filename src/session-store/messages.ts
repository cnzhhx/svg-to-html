import type { Session, SessionMessage } from './types.js'

const AGENT_MESSAGE_SAMPLE_CHARS = Math.max(
  0,
  Number(process.env['SESSION_AGENT_MESSAGE_SAMPLE_CHARS'] ?? 100),
)
const AGENT_REASONING_MESSAGE_CHARS = Math.max(
  0,
  Number(process.env['SESSION_AGENT_REASONING_MESSAGE_CHARS'] ?? 4_000),
)

const sampleText = (value: string, maxChars = AGENT_MESSAGE_SAMPLE_CHARS) => {
  if (maxChars <= 0) return ''
  return value.length <= maxChars ? value : value.slice(0, maxChars)
}

const sampleString = (value: unknown) =>
  typeof value === 'string' ? sampleText(value) : ''

const sampleUnknown = (value: unknown) => {
  if (value === undefined) return ''
  if (typeof value === 'string') return sampleText(value)
  try {
    return sampleText(JSON.stringify(value))
  } catch {
    return sampleText(String(value))
  }
}

const isAgentMessageItemType = (
  value: unknown,
): value is NonNullable<SessionMessage['agentItemType']> =>
  value === 'agent_message' ||
  value === 'command_execution' ||
  value === 'error' ||
  value === 'mcp_tool_call' ||
  value === 'reasoning'

const labelForStatus = (value: unknown) => {
  if (value === 'in_progress') return '执行中'
  if (value === 'completed') return '完成'
  if (value === 'failed') return '失败'
  return sampleString(value)
}

const sampleEventText = (lines: string[]) =>
  sampleText(lines.filter(Boolean).join('\n'))

type UpsertSessionMessageOptions = {
  enqueueForAgent?: boolean
}

const upsertSessionMessage = (
  session: Session,
  message: Omit<SessionMessage, 'createdAt'>,
  options?: UpsertSessionMessageOptions,
): SessionMessage => {
  const existingIndex = session.messages.findIndex((entry) => entry.id === message.id)
  const createdAt =
    existingIndex >= 0 ? session.messages[existingIndex]!.createdAt : Date.now()
  const created = {
    ...message,
    createdAt,
  }

  if (existingIndex >= 0) {
    session.messages[existingIndex] = created
  } else {
    session.messages.push(created)
  }

  if (options?.enqueueForAgent && created.role === 'user' && existingIndex === -1) {
    session.pendingUserMessages.push({
      moduleId: created.moduleId,
      text: created.text,
    })
  }

  session.updatedAt = Date.now()
  return created
}

const sessionMessageFromAgentEvent = (
  event: Record<string, unknown>,
): Omit<SessionMessage, 'createdAt'> | undefined => {
  const eventType = event['type']
  if (
    eventType !== 'item.started' &&
    eventType !== 'item.updated' &&
    eventType !== 'item.completed'
  ) {
    return undefined
  }

  const item = event['item']
  if (!item || typeof item !== 'object') return undefined
  const itemRecord = item as Record<string, unknown>

  const itemId = itemRecord['id']
  const itemType = itemRecord['type']
  if (
    typeof itemId !== 'string' ||
    !isAgentMessageItemType(itemType)
  ) {
    return undefined
  }

  const status = labelForStatus(itemRecord['status'])
  const text =
    itemType === 'error'
      ? sampleString(itemRecord['message'])
      : itemType === 'agent_message'
        ? typeof itemRecord['text'] === 'string'
          ? itemRecord['text']
          : ''
        : itemType === 'reasoning'
          ? typeof itemRecord['text'] === 'string'
            ? sampleText(itemRecord['text'], AGENT_REASONING_MESSAGE_CHARS)
            : ''
          : itemType === 'command_execution'
            ? sampleEventText([
                `命令${status ? ` ${status}` : ''}: ${sampleString(itemRecord['command'])}`,
                sampleString(itemRecord['aggregated_output'])
                  ? `输出: ${sampleString(itemRecord['aggregated_output'])}`
                  : '',
              ])
            : itemType === 'mcp_tool_call'
              ? sampleEventText([
                  `工具${status ? ` ${status}` : ''}: ${[
                    sampleString(itemRecord['server']),
                    sampleString(itemRecord['tool']),
                  ]
                    .filter(Boolean)
                    .join('/')}`,
                  itemRecord['error'] &&
                  typeof itemRecord['error'] === 'object' &&
                  typeof (itemRecord['error'] as Record<string, unknown>)[
                    'message'
                  ] === 'string'
                    ? `错误: ${sampleString(
                        (itemRecord['error'] as Record<string, unknown>)[
                          'message'
                        ],
                      )}`
                    : '',
                  sampleUnknown(itemRecord['result'])
                    ? `结果: ${sampleUnknown(itemRecord['result'])}`
                    : '',
                ])
              : ''
  const moduleId =
    typeof event['moduleId'] === 'string'
      ? event['moduleId']
      : typeof itemRecord['moduleId'] === 'string'
        ? itemRecord['moduleId']
        : undefined
  const sourceLabel =
    typeof event['sourceLabel'] === 'string'
      ? event['sourceLabel']
      : typeof itemRecord['sourceLabel'] === 'string'
        ? itemRecord['sourceLabel']
        : undefined

  return {
    agentEventType: eventType,
    agentItemType: itemType,
    id: itemId,
    kind: itemType === 'agent_message' ? 'chat' : 'event',
    ...(moduleId ? { moduleId } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
    role: 'assistant',
    text,
  }
}

export { sessionMessageFromAgentEvent, upsertSessionMessage }
