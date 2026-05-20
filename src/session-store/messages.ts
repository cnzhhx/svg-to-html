import type { Session, SessionMessage } from './types.js'

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

const sessionMessageFromCodexEvent = (
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
    (itemType !== 'agent_message' && itemType !== 'error')
  ) {
    return undefined
  }

  const text =
    itemType === 'error'
      ? itemRecord['message']
      : itemType === 'agent_message'
        ? itemRecord['text']
        : ''

  return {
    codexEventType: eventType,
    codexItemType: itemType,
    id: itemId,
    kind: itemType === 'agent_message' ? 'chat' : 'event',
    role: 'assistant',
    text: typeof text === 'string' ? text : '',
  }
}

export { sessionMessageFromCodexEvent, upsertSessionMessage }
