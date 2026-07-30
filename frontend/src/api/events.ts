import type { JobEvent } from '../types/events'
import { basePath } from './http'

export const connectJobEvents = (
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onError?: (error: Event) => void,
) => {
  const source = new EventSource(`${basePath}/api/jobs/${encodeURIComponent(jobId)}/events`)
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as JobEvent)
    } catch (error) {
      console.warn('Ignoring invalid job event', error)
    }
  }
  if (onError) source.onerror = onError
  return source
}
