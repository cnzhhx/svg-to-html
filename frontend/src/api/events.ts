import type { SessionEvent } from '../types/events'
import { basePath } from './http'

export const connectSessionEvents = (
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  onError?: (error: Event) => void,
) => {
  const source = new EventSource(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/events`)
  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as SessionEvent)
  }
  if (onError) source.onerror = onError
  return source
}
