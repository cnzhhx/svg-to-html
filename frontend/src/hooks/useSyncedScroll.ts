import { useCallback, useRef } from 'react'

export function useSyncedScroll() {
  const syncingRef = useRef(false)
  return useCallback((event: React.UIEvent<HTMLElement>) => {
    if (syncingRef.current) return
    const target = event.target as HTMLElement
    if (!target?.hasAttribute?.('data-result-scroll-frame')) return
    const parent = target.closest('.result-grid')
    if (!parent) return
    const frames = Array.from(parent.querySelectorAll<HTMLElement>('[data-result-scroll-frame]'))
    syncingRef.current = true
    frames.forEach((frame) => {
      if (frame !== target) {
        frame.scrollTop = target.scrollTop
        frame.scrollLeft = target.scrollLeft
      }
    })
    window.requestAnimationFrame(() => {
      syncingRef.current = false
    })
  }, [])
}
