import { useCallback, useEffect, useRef } from 'react'
import type { AgentEvent } from '../../types/events'
import type { Session } from '../../types/session'
import { livePreviewUrl } from '../../utils/artifacts'
import { ChatDrawer } from '../chat/ChatDrawer'

export function RunningWorkspace({
  agentEvents,
  chatDisabled,
  chatFilterModuleId,
  onFilterModule,
  onSelectModule,
  selectedModuleId,
  session,
}: {
  agentEvents: AgentEvent[]
  chatDisabled: boolean
  chatFilterModuleId: string | null
  onFilterModule: (moduleId: string | null) => void
  onSelectModule: (moduleId: string | null) => void
  selectedModuleId: string | null
  session: Session | null
}) {
  const previewUrl = livePreviewUrl(session, selectedModuleId)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const applyModuleHighlight = useCallback(() => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    const win = frame?.contentWindow
    if (!doc || !win) return
    doc.querySelectorAll('.live-preview-react-selected-module').forEach((element) => {
      element.classList.remove('live-preview-react-selected-module')
    })
    if (!selectedModuleId) return
    const moduleElement = Array.from(doc.querySelectorAll<HTMLElement>('.design-module[data-module-id]'))
      .find((element) => element.dataset.moduleId === selectedModuleId)
    if (!moduleElement) return
    if (!doc.getElementById('live-preview-react-highlight-style')) {
      const style = doc.createElement('style')
      style.id = 'live-preview-react-highlight-style'
      style.textContent = `
        .design-module.live-preview-react-selected-module {
          outline: calc(4px / var(--live-preview-scale, 1)) solid #0ea5e9 !important;
          outline-offset: calc(3px / var(--live-preview-scale, 1)) !important;
          box-shadow:
            0 0 0 calc(1px / var(--live-preview-scale, 1)) rgba(255, 255, 255, 0.94),
            0 0 calc(28px / var(--live-preview-scale, 1)) rgba(14, 165, 233, 0.42) !important;
          z-index: 2147483646 !important;
        }
      `
      doc.head.appendChild(style)
    }
    moduleElement.classList.add('live-preview-react-selected-module')
    const rect = moduleElement.getBoundingClientRect()
    const targetTop = win.scrollY + rect.top + rect.height / 2 - win.innerHeight / 2
    win.requestAnimationFrame(() => {
      win.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
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
          onSelectModule={onSelectModule}
          open
          selectedModuleId={selectedModuleId}
          session={session}
          variant="embedded"
        />
      </div>
      <div className="live-preview-pane">
        <div className="live-preview-frame-shell">
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
