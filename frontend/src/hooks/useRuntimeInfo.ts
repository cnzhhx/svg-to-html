import { useEffect } from 'react'
import { loadRuntimeInfo } from '../api/runtime'
import type { RuntimeInfo } from '../types/runtime'

export function useRuntimeInfo(onLoaded: (runtime: RuntimeInfo) => void, onError: (error: string) => void) {
  useEffect(() => {
    let cancelled = false
    loadRuntimeInfo()
      .then((runtime) => {
        if (!cancelled) onLoaded(runtime)
      })
      .catch((error) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [onError, onLoaded])
}
