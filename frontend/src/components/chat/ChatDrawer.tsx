import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sendSessionMessage } from '../../api/sessions'
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea'
import type { AgentEvent } from '../../types/events'
import type { Session, SessionMessage } from '../../types/session'
import { labelForSessionStatus } from '../../utils/format'
import { collectChatFilterModules } from '../../utils/modules'
import { ModulePicker } from './ModulePicker'

export function ChatDrawer({
  agentEvents,
  chatFilterModuleId,
  disabled,
  onClose,
  onFilterModule,
  onSelectModule,
  open,
  selectedModuleId,
  session,
}: {
  agentEvents: AgentEvent[]
  chatFilterModuleId: string | null
  disabled: boolean
  onClose: () => void
  onFilterModule: (moduleId: string | null) => void
  onSelectModule: (moduleId: string | null) => void
  open: boolean
  selectedModuleId: string | null
  session: Session | null
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useAutoResizeTextarea(text)
  const moduleIds = collectChatFilterModules(session)
  const canSend = Boolean(session && selectedModuleId && text.trim() && !busy && !disabled && session.status !== 'running' && session.status !== 'queued')

  const messages = useMemo(() => {
    const items = session?.messages || []
    if (!chatFilterModuleId) return items
    return items.filter((message) => message.moduleId === chatFilterModuleId)
  }, [chatFilterModuleId, session?.messages])
  const filteredAgentEvents = useMemo(() => {
    if (!chatFilterModuleId) return agentEvents
    return agentEvents.filter((event) => getAgentEventModuleId(event) === chatFilterModuleId)
  }, [agentEvents, chatFilterModuleId])

  const scrollConversationToBottom = useCallback(() => {
    const element = conversationRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [])

  useEffect(() => {
    if (!open) return undefined
    scrollConversationToBottom()
    const frame = window.requestAnimationFrame(scrollConversationToBottom)
    return () => window.cancelAnimationFrame(frame)
  }, [
    chatFilterModuleId,
    filteredAgentEvents,
    messages,
    open,
    scrollConversationToBottom,
    selectedModuleId,
    session?.id,
  ])

  const selectChatFilter = (moduleId: string | null) => {
    onFilterModule(moduleId)
    if (moduleId) onSelectModule(moduleId)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!session?.id || !selectedModuleId || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await sendSessionMessage(session.id, selectedModuleId, text.trim())
      setText('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`chat-drawer${open ? ' open' : ''}`}>
      <div className="chat-drawer-header">
        <div className="chat-drawer-heading">
          <strong className="chat-drawer-title">聊天调整</strong>
          <span className="chat-drawer-meta">{disabled ? '聊天功能已关闭' : session ? `${labelForSessionStatus(session)} · 可查看聊天记录` : '选择 session 后可查看聊天'}</span>
        </div>
        <button className="icon-btn" onClick={onClose} title="关闭聊天" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <ModulePicker onSelectModule={onSelectModule} selectedModuleId={selectedModuleId} session={session} />
      <div className="chat-filter-tabs">
        <button className={`chat-filter-tab${!chatFilterModuleId ? ' is-selected' : ''}`} onClick={() => selectChatFilter(null)} type="button">全部</button>
        {moduleIds.map((moduleId) => (
          <button className={`chat-filter-tab${chatFilterModuleId === moduleId ? ' is-selected' : ''}`} key={moduleId} onClick={() => selectChatFilter(moduleId)} type="button">{moduleId}</button>
        ))}
      </div>
      <div className="conversation-stream" ref={conversationRef}>
        {messages.length || filteredAgentEvents.length ? (
          <>
            {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {filteredAgentEvents.slice(-40).map((event, index) => <AgentEventRow event={event} key={`${String(event.type)}-${index}`} />)}
          </>
        ) : (
          <div className="empty-state">暂无聊天记录</div>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea disabled={disabled || !session} onChange={(event) => setText(event.target.value)} placeholder="输入调整要求…" ref={textareaRef} rows={1} value={text} />
        <div className="composer-footer">
          <span className="composer-hint">{error || (selectedModuleId ? '发送需点击按钮，Enter 不会提交' : '请先选择模块')}</span>
          <button className="send-btn" disabled={!canSend} type="submit">{busy ? '发送中…' : '发送'}</button>
        </div>
      </form>
    </section>
  )
}

function MessageBubble({ message }: { message: SessionMessage }) {
  if (message.agentItemType === 'reasoning') {
    return (
      <ReasoningDisclosure
        moduleId={message.moduleId}
        text={message.text}
        title="Think"
      />
    )
  }
  return (
    <article className={`message-bubble role-${message.role} kind-${message.kind}`}>
      {message.moduleId ? <span className="bubble-source">模块 {message.moduleId}</span> : null}
      <div className="bubble-text">{message.text}</div>
    </article>
  )
}

function AgentEventRow({ event }: { event: AgentEvent }) {
  const item = event.item
  const moduleId = getAgentEventModuleId(event)
  const title = String(item?.type || event.type || 'agent event')
  const text = String(item?.text || item?.aggregated_output || item?.message || item?.command || '')
  if (String(item?.type || '').trim() === 'reasoning') {
    return <ReasoningDisclosure moduleId={moduleId} text={text} title="Think" />
  }
  return (
    <div className="agent-runtime-item">
      <div className="agent-event-head">
        {moduleId ? <span className="event-source-badge">模块 {moduleId}</span> : <span className="event-source-badge">Session</span>}
        <span>{title}</span>
      </div>
      {text ? <pre>{text}</pre> : null}
    </div>
  )
}

function ReasoningDisclosure({
  moduleId,
  text,
  title,
}: {
  moduleId?: string
  text: string
  title: string
}) {
  return (
    <details className="reasoning-disclosure">
      <summary>
        {moduleId ? <span className="event-source-badge">模块 {moduleId}</span> : null}
        <span>{title}</span>
        <span className="reasoning-summary-hint">点击展开</span>
      </summary>
      {text ? <pre>{text}</pre> : null}
    </details>
  )
}

function getAgentEventModuleId(event: AgentEvent) {
  const item = event.item
  const direct = String(event.moduleId || item?.moduleId || '').trim()
  if (direct) return direct
  const source = String(event.sourceLabel || item?.server || item?.tool || '').trim()
  return source.match(/module-\d+/i)?.[0] || ''
}
