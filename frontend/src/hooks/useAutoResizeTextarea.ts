import { useEffect, useRef } from 'react'

export function useAutoResizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(160, Math.max(42, element.scrollHeight))}px`
  }, [value])
  return ref
}
