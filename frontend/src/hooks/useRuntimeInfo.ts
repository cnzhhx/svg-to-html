import { useEffect } from 'react'
import { loadRuntimeInfo } from '../api/runtime'
import type { RuntimeInfo } from '../types/runtime'

export function useRuntimeInfo(onLoaded: (runtime: RuntimeInfo) => void, onError: (error: string) => void) {
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      loadRuntimeInfo()
        .then((runtime) => {
          if (!cancelled) onLoaded(runtime)
        })
        .catch((error) => {
          if (!cancelled) onError(error instanceof Error ? error.message : String(error))
        })
    }
    refresh()
    const timer = window.setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    window.addEventListener('svg-runtime-refresh', refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('svg-runtime-refresh', refresh)
    }
  }, [onError, onLoaded])
}
