import { useEffect, useRef } from 'react'
import { connectSessionEvents } from '../api/events'
import type { SessionEvent } from '../types/events'

const getEventSessionId = (event: SessionEvent) =>
  event.type === 'init' ? event.session.id : event.sessionId

export function useSessionEvents(sessionId: string | null, onEvent: (event: SessionEvent) => void) {
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!sessionId) return undefined
    let active = true
    const source = connectSessionEvents(sessionId, (event) => {
      if (!active || getEventSessionId(event) !== sessionId) return
      onEventRef.current(event)
    })
    return () => {
      active = false
      source.close()
    }
  }, [sessionId])
}
