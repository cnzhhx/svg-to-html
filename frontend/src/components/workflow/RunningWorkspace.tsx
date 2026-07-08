import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '../../types/events'
import type { Job, JobMessage } from '../../types/job'
import { livePreviewUrl } from '../../utils/artifacts'
import { STORAGE_KEYS, readJsonStorage, writeJsonStorage } from '../../utils/storage'
import { ChatDrawer } from '../chat/ChatDrawer'

type PreviewSlot = 'primary' | 'secondary'
type PreviewFitMode = 'width' | 'height'

const previewSlots: PreviewSlot[] = ['primary', 'secondary']
const previewSwapDelayMs = 0
const previewInitialCommitDelayMs = 160
const previewUpdateCommitDelayMs = 80

const isPreviewFitMode = (value: unknown): value is PreviewFitMode =>
  value === 'width' || value === 'height'

const readStoredPreviewFitModes = () => {
  const stored = readJsonStorage<Record<string, unknown>>(STORAGE_KEYS.runningPreviewFitModes, {})
  return Object.fromEntries(
    Object.entries(stored).flatMap(([jobId, value]) =>
      jobId && isPreviewFitMode(value) ? [[jobId, value]] : [],
    ),
  ) as Record<string, PreviewFitMode>
}

export function RunningWorkspace({
  agentEvents,
  chatDisabled,
  chatFilterModuleId,
  onFilterModule,
  onMessageQueued,
  onSelectModule,
  selectedModuleId,
  job,
}: {
  agentEvents: AgentEvent[]
  chatDisabled: boolean
  chatFilterModuleId: string | null
  onFilterModule: (moduleId: string | null) => void
  onMessageQueued?: (message: JobMessage) => void
  onSelectModule: (moduleId: string | null) => void
  selectedModuleId: string | null
  job: Job | null
}) {
  const jobId = job?.id || ''
  const [previewFitModesByJob, setPreviewFitModesByJob] = useState<Record<string, PreviewFitMode>>(readStoredPreviewFitModes)
  const storedPreviewFitMode = jobId ? (previewFitModesByJob[jobId] || 'width') : 'width'
  const [heightFitFrameWidth, setHeightFitFrameWidth] = useState<{ jobId: string; width: number } | null>(null)
  const rawPreviewUrl = livePreviewUrl(job)
  const [previewCommit, setPreviewCommit] = useState<{ jobId: string; url: string }>(() => ({ jobId: '', url: '' }))
  const previewCommitRef = useRef(previewCommit)
  const frameRefs = useRef<Record<PreviewSlot, HTMLIFrameElement | null>>({
    primary: null,
    secondary: null,
  })
  const frameShellRef = useRef<HTMLDivElement | null>(null)
  const [previewFrames, setPreviewFrames] = useState<{
    activeSlot: PreviewSlot
    pendingSlot: PreviewSlot | null
    readySlot: PreviewSlot | null
    jobId: string
    urls: Record<PreviewSlot, string>
  }>(() => ({
    activeSlot: 'primary',
    pendingSlot: null,
    readySlot: null,
    jobId: '',
    urls: { primary: '', secondary: '' },
  }))
  const previewAspectRatio = useMemo(() => {
    const width = Number(job?.result?.designWidth || 0)
    const height = Number(job?.result?.designHeight || 0)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return width / height
  }, [job?.result?.designHeight, job?.result?.designWidth])
  const previewFitMode = storedPreviewFitMode === 'height' && !previewAspectRatio ? 'width' : storedPreviewFitMode
  const activeHeightFitFrameWidth = heightFitFrameWidth?.jobId === jobId ? heightFitFrameWidth.width : null
  const previewUrl = previewCommit.jobId === jobId ? previewCommit.url : ''
  const renderedPreviewFrames = previewFrames.jobId === jobId
    ? previewFrames
    : {
        activeSlot: 'primary' as PreviewSlot,
        pendingSlot: null,
        readySlot: null,
        jobId,
        urls: { primary: previewUrl, secondary: '' },
      }

  const commitPreviewUrl = useCallback((next: { jobId: string; url: string }) => {
    previewCommitRef.current = next
    setPreviewCommit((previous) => (
      previous.jobId === next.jobId && previous.url === next.url ? previous : next
    ))
  }, [])

  useEffect(() => {
    previewCommitRef.current = previewCommit
  }, [previewCommit])

  useEffect(() => {
    const current = previewCommitRef.current
    if (!rawPreviewUrl) {
      commitPreviewUrl({ jobId, url: '' })
      return undefined
    }
    if (current.jobId === jobId && current.url === rawPreviewUrl) return undefined
    if (current.jobId !== jobId) {
      commitPreviewUrl({ jobId, url: '' })
    }
    const delay = current.jobId === jobId && current.url
      ? previewUpdateCommitDelayMs
      : previewInitialCommitDelayMs
    const timer = window.setTimeout(() => {
      commitPreviewUrl({ jobId, url: rawPreviewUrl })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [commitPreviewUrl, rawPreviewUrl, jobId])

  const updatePreviewFitMode = useCallback((mode: PreviewFitMode) => {
    if (!jobId) return
    setPreviewFitModesByJob((previous) => {
      if (previous[jobId] === mode) return previous
      const next = { ...previous, [jobId]: mode }
      writeJsonStorage(STORAGE_KEYS.runningPreviewFitModes, next)
      return next
    })
  }, [jobId])

  useLayoutEffect(() => {
    const shell = frameShellRef.current
    if (!shell || previewFitMode !== 'height' || !previewAspectRatio) {
      setHeightFitFrameWidth((previous) => (previous?.jobId === jobId ? null : previous))
      return undefined
    }
    const updateFrameWidth = () => {
      const rect = shell.getBoundingClientRect()
      const nextWidth = Math.min(rect.width, rect.height * previewAspectRatio)
      setHeightFitFrameWidth((previous) => {
        if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
          return previous?.jobId === jobId ? null : previous
        }
        if (previous?.jobId === jobId && Math.abs(previous.width - nextWidth) < 0.5) {
          return previous
        }
        return { jobId, width: nextWidth }
      })
    }
    updateFrameWidth()
    const observer = new ResizeObserver(updateFrameWidth)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [previewAspectRatio, previewFitMode, jobId])

  useLayoutEffect(() => {
    setPreviewFrames((previous) => {
      if (previous.jobId !== jobId) {
        return {
          activeSlot: 'primary',
          pendingSlot: null,
          readySlot: null,
          jobId,
          urls: { primary: previewUrl, secondary: '' },
        }
      }
      if (!previewUrl) {
        if (!previous.urls.primary && !previous.urls.secondary) return previous
        return {
          activeSlot: 'primary',
          pendingSlot: null,
          readySlot: null,
          jobId,
          urls: { primary: '', secondary: '' },
        }
      }
      const activeUrl = previous.urls[previous.activeSlot]
      const pendingUrl = previous.pendingSlot ? previous.urls[previous.pendingSlot] : ''
      if (activeUrl === previewUrl || pendingUrl === previewUrl) return previous
      if (!activeUrl) {
        return {
          ...previous,
          pendingSlot: null,
          readySlot: null,
          jobId,
          urls: {
            ...previous.urls,
            [previous.activeSlot]: previewUrl,
          },
        }
      }
      const pendingSlot: PreviewSlot = previous.activeSlot === 'primary' ? 'secondary' : 'primary'
      return {
        ...previous,
        pendingSlot,
        readySlot: null,
        jobId,
        urls: {
          ...previous.urls,
          [pendingSlot]: previewUrl,
        },
      }
    })
  }, [previewUrl, jobId])

  useEffect(() => {
    const pendingSlot = previewFrames.pendingSlot
    if (!pendingSlot || previewFrames.readySlot !== pendingSlot) return undefined
    const timer = window.setTimeout(() => {
      setPreviewFrames((previous) => {
        const nextActiveSlot = previous.pendingSlot
        if (!nextActiveSlot || previous.readySlot !== nextActiveSlot) return previous
        const previousActiveSlot = previous.activeSlot
        return {
          activeSlot: nextActiveSlot,
          pendingSlot: null,
          readySlot: null,
          jobId: previous.jobId,
          urls: {
            ...previous.urls,
            [previousActiveSlot]: '',
          },
        }
      })
    }, previewSwapDelayMs)
    return () => window.clearTimeout(timer)
  }, [previewFrames.pendingSlot, previewFrames.readySlot])

  const applyModuleHighlight = useCallback((slot: PreviewSlot = previewFrames.activeSlot, behavior: ScrollBehavior = 'smooth') => {
    const frame = frameRefs.current[slot]
    const doc = frame?.contentDocument
    const win = frame?.contentWindow
    if (!doc || !win) return
    const previewWindow = win as Window & { __livePreviewReactHighlightCleanup?: () => void }
    previewWindow.__livePreviewReactHighlightCleanup?.()
    previewWindow.__livePreviewReactHighlightCleanup = undefined
    doc.querySelectorAll('.live-preview-react-selected-module').forEach((element) => {
      element.classList.remove('live-preview-react-selected-module')
    })
    doc.querySelectorAll('.live-preview-selected-module').forEach((element) => {
      element.classList.remove('live-preview-selected-module')
    })
    doc.getElementById('live-preview-module-highlight')?.remove()
    doc.getElementById('live-preview-react-highlight-overlay')?.remove()
    if (!selectedModuleId) return
    const moduleElement = Array.from(doc.querySelectorAll<HTMLElement>('.design-module[data-module-id]'))
      .find((element) => element.dataset.moduleId === selectedModuleId)
    if (!moduleElement) return
    let style = doc.getElementById('live-preview-react-highlight-style')
    if (!style) {
      style = doc.createElement('style')
      style.id = 'live-preview-react-highlight-style'
      doc.head.appendChild(style)
    }
    style.textContent = `
        .design-module.live-preview-selected-module,
        .design-module.live-preview-react-selected-module {
          outline: 0 !important;
          outline-offset: 0 !important;
          box-shadow: none !important;
        }

        #live-preview-module-highlight {
          display: none !important;
        }

        .live-preview-react-module-highlight {
          position: fixed;
          box-sizing: border-box;
          pointer-events: none;
          border: 3px solid #0ea5e9;
          border-radius: 2px;
          box-shadow: none;
          z-index: 2147483646 !important;
        }
      `
    const overlay = doc.createElement('div')
    overlay.id = 'live-preview-react-highlight-overlay'
    overlay.className = 'live-preview-react-module-highlight'
    doc.body.appendChild(overlay)

    const positionOverlay = () => {
      const rect = moduleElement.getBoundingClientRect()
      const inset = 3
      const left = Math.max(inset, rect.left + inset)
      const top = Math.max(inset, rect.top + inset)
      const right = Math.min(win.innerWidth - inset, rect.right - inset)
      const bottom = Math.min(win.innerHeight - inset, rect.bottom - inset)
      if (right <= left || bottom <= top) {
        overlay.style.display = 'none'
        return
      }
      overlay.style.display = 'block'
      overlay.style.left = `${left}px`
      overlay.style.top = `${top}px`
      overlay.style.width = `${right - left}px`
      overlay.style.height = `${bottom - top}px`
    }

    let rafId = 0
    const schedulePosition = () => {
      win.cancelAnimationFrame(rafId)
      rafId = win.requestAnimationFrame(positionOverlay)
    }
    win.addEventListener('scroll', schedulePosition, { passive: true })
    win.addEventListener('resize', schedulePosition, { passive: true })
    previewWindow.__livePreviewReactHighlightCleanup = () => {
      win.cancelAnimationFrame(rafId)
      win.removeEventListener('scroll', schedulePosition)
      win.removeEventListener('resize', schedulePosition)
      overlay.remove()
    }

    const rect = moduleElement.getBoundingClientRect()
    const targetTop = win.scrollY + rect.top + rect.height / 2 - win.innerHeight / 2
    positionOverlay()
    win.requestAnimationFrame(() => {
      win.scrollTo({ top: Math.max(0, targetTop), behavior })
      schedulePosition()
    })
  }, [previewFrames.activeSlot, selectedModuleId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      applyModuleHighlight(previewFrames.activeSlot)
      if (previewFrames.pendingSlot) applyModuleHighlight(previewFrames.pendingSlot, 'auto')
    }, 80)
    return () => {
      window.clearTimeout(timer)
    }
  }, [applyModuleHighlight, previewFrames.activeSlot, previewFrames.pendingSlot])

  const syncPendingFrameViewport = useCallback((slot: PreviewSlot) => {
    if (selectedModuleId) return
    const sourceWindow = frameRefs.current[previewFrames.activeSlot]?.contentWindow
    const targetWindow = frameRefs.current[slot]?.contentWindow
    if (!sourceWindow || !targetWindow || sourceWindow === targetWindow) return
    const left = sourceWindow.scrollX
    const top = sourceWindow.scrollY
    targetWindow.requestAnimationFrame(() => {
      targetWindow.scrollTo({ left, top, behavior: 'auto' })
    })
  }, [previewFrames.activeSlot, selectedModuleId])

  const handleFrameLoad = useCallback((slot: PreviewSlot, url: string) => {
    const isPending = previewFrames.pendingSlot === slot
    applyModuleHighlight(slot, isPending ? 'auto' : 'smooth')
    if (isPending) syncPendingFrameViewport(slot)
    setPreviewFrames((previous) => {
      if (previous.urls[slot] !== url || previous.pendingSlot !== slot) return previous
      return { ...previous, readySlot: slot }
    })
  }, [applyModuleHighlight, previewFrames.pendingSlot, syncPendingFrameViewport])

  return (
    <section className="running-workspace">
      <div className="running-chat-pane">
        <ChatDrawer
          agentEvents={agentEvents}
          chatFilterModuleId={chatFilterModuleId}
          disabled={chatDisabled}
          onClose={() => undefined}
          onFilterModule={onFilterModule}
          onMessageQueued={onMessageQueued}
          onSelectModule={onSelectModule}
          open
          selectedModuleId={selectedModuleId}
          job={job}
          variant="embedded"
        />
      </div>
      <div className="live-preview-pane">
        <div className="live-preview-fit-toggle result-view-toggle" role="group" aria-label="实时预览适配模式">
          <button
            className={`result-view-toggle-btn${previewFitMode === 'width' ? ' is-active' : ''}`}
            onClick={() => updatePreviewFitMode('width')}
            type="button"
          >
            宽度
          </button>
          <button
            className={`result-view-toggle-btn${previewFitMode === 'height' ? ' is-active' : ''}`}
            disabled={!previewAspectRatio}
            onClick={() => updatePreviewFitMode('height')}
            type="button"
          >
            高度
          </button>
        </div>
        <div
          ref={frameShellRef}
          className={`live-preview-frame-shell fit-${previewFitMode}`}
          style={{
            ...(previewAspectRatio ? { ['--live-preview-host-ratio' as string]: String(previewAspectRatio) } : {}),
            ...(activeHeightFitFrameWidth ? { ['--live-preview-frame-width' as string]: `${activeHeightFitFrameWidth}px` } : {}),
          }}
        >
          {previewUrl ? (
            <div className="live-preview-frame-stack">
              {previewSlots.map((slot) => {
                const url = renderedPreviewFrames.urls[slot]
                if (!url) return null
                const isActive = slot === renderedPreviewFrames.activeSlot
                const isPending = slot === renderedPreviewFrames.pendingSlot
                const isReady = slot === renderedPreviewFrames.readySlot
                return (
                  <iframe
                    className={[
                      'live-preview-frame',
                      isActive ? 'is-active' : '',
                      isPending ? 'is-pending' : '',
                      isReady ? 'is-ready' : '',
                    ].filter(Boolean).join(' ')}
                    key={`${renderedPreviewFrames.jobId}:${slot}`}
                    onLoad={() => handleFrameLoad(slot, url)}
                    ref={(element) => {
                      frameRefs.current[slot] = element
                    }}
                    src={url}
                    title="实时预览"
                  />
                )
              })}
            </div>
          ) : (
            <div className="live-preview-empty">
              <strong>正在准备预览</strong>
              <span>模块结构解析完成后会显示整页 HTML 预览。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
