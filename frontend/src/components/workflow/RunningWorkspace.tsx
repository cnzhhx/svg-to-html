import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '../../types/events'
import type { Session, SessionMessage } from '../../types/session'
import { livePreviewUrl } from '../../utils/artifacts'
import { ChatDrawer } from '../chat/ChatDrawer'

export function RunningWorkspace({
  agentEvents,
  chatDisabled,
  chatFilterModuleId,
  onFilterModule,
  onMessageQueued,
  onSelectModule,
  selectedModuleId,
  session,
}: {
  agentEvents: AgentEvent[]
  chatDisabled: boolean
  chatFilterModuleId: string | null
  onFilterModule: (moduleId: string | null) => void
  onMessageQueued?: (message: SessionMessage) => void
  onSelectModule: (moduleId: string | null) => void
  selectedModuleId: string | null
  session: Session | null
}) {
  const [previewFitMode, setPreviewFitMode] = useState<'width' | 'height'>('width')
  const [heightFitFrameWidth, setHeightFitFrameWidth] = useState<number | null>(null)
  const previewUrl = livePreviewUrl(session, selectedModuleId)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameShellRef = useRef<HTMLDivElement | null>(null)
  const previewAspectRatio = useMemo(() => {
    const width = Number(session?.result?.designWidth || 0)
    const height = Number(session?.result?.designHeight || 0)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return width / height
  }, [session?.result?.designHeight, session?.result?.designWidth])

  useEffect(() => {
    const shell = frameShellRef.current
    if (!shell || previewFitMode !== 'height' || !previewAspectRatio) {
      setHeightFitFrameWidth(null)
      return undefined
    }
    const updateFrameWidth = () => {
      const rect = shell.getBoundingClientRect()
      const nextWidth = Math.min(rect.width, rect.height * previewAspectRatio)
      setHeightFitFrameWidth(Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : null)
    }
    updateFrameWidth()
    const observer = new ResizeObserver(updateFrameWidth)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [previewAspectRatio, previewFitMode])

  const applyModuleHighlight = useCallback(() => {
    const frame = frameRef.current
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
      win.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
      schedulePosition()
    })
  }, [selectedModuleId])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    const handleLoad = () => applyModuleHighlight()
    frame.addEventListener('load', handleLoad)
    const timer = window.setTimeout(applyModuleHighlight, 80)
    return () => {
      frame.removeEventListener('load', handleLoad)
      window.clearTimeout(timer)
    }
  }, [applyModuleHighlight, previewUrl])

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
          session={session}
          variant="embedded"
        />
      </div>
      <div className="live-preview-pane">
        <div className="live-preview-fit-toggle result-view-toggle" role="group" aria-label="实时预览适配模式">
          <button
            className={`result-view-toggle-btn${previewFitMode === 'width' ? ' is-active' : ''}`}
            onClick={() => setPreviewFitMode('width')}
            type="button"
          >
            宽度
          </button>
          <button
            className={`result-view-toggle-btn${previewFitMode === 'height' ? ' is-active' : ''}`}
            disabled={!previewAspectRatio}
            onClick={() => setPreviewFitMode('height')}
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
            ...(heightFitFrameWidth ? { ['--live-preview-frame-width' as string]: `${heightFitFrameWidth}px` } : {}),
          }}
        >
          {previewUrl ? (
            <iframe className="live-preview-frame" key={previewUrl} ref={frameRef} src={previewUrl} title="实时预览" />
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
