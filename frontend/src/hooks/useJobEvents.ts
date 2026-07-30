import { useEffect, useRef } from 'react'
import { connectJobEvents } from '../api/events'
import type { JobEvent } from '../types/events'

const getEventJobId = (event: JobEvent) =>
  event.type === 'init' ? event.job.id : event.jobId

export function useJobEvents(jobId: string | null, onEvent: (event: JobEvent) => void) {
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!jobId) return undefined
    let active = true
    const source = connectJobEvents(jobId, (event) => {
      if (!active || getEventJobId(event) !== jobId) return
      onEventRef.current(event)
    })
    return () => {
      active = false
      source.close()
    }
  }, [jobId])
}
