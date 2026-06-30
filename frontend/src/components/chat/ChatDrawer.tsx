import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sendSessionMessage } from '../../api/sessions'
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea'
import type { AgentEvent } from '../../types/events'
import type { Session, SessionMessage } from '../../types/session'
import { labelForSessionStatus } from '../../utils/format'
import { ModulePicker } from './ModulePicker'

export function ChatDrawer({
  agentEvents,
  chatFilterModuleId,
  disabled,
  onClose,
  onFilterModule,
  onMessageQueued,
  onSelectModule,
  open,
  selectedModuleId,
  session,
  variant = 'drawer',
}: {
  agentEvents: AgentEvent[]
  chatFilterModuleId: string | null
  disabled: boolean
  onClose: () => void
  onFilterModule: (moduleId: string | null) => void
  onMessageQueued?: (message: SessionMessage) => void
  onSelectModule: (moduleId: string | null) => void
  open: boolean
  selectedModuleId: string | null
  session: Session | null
  variant?: 'drawer' | 'embedded'
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useAutoResizeTextarea(text)
  const canSend = Boolean(session && selectedModuleId && text.trim() && !busy && !disabled && session.status !== 'queued')
  const activeModuleId = selectedModuleId

  const messages = useMemo(() => {
    const items = session?.messages || []
    if (!activeModuleId) return items
    return items.filter((message) => message.moduleId === activeModuleId)
  }, [activeModuleId, session?.messages])
  const filteredAgentEvents = useMemo(() => {
    if (!activeModuleId) return agentEvents
    return agentEvents.filter((event) => getAgentEventModuleId(event) === activeModuleId)
  }, [activeModuleId, agentEvents])
  const conversationItems = useMemo(() => {
    const messageItems = messages.map((message) => ({
      id: `message-${message.id}`,
      kind: 'message' as const,
      message,
      timestamp: Number(message.createdAt || 0),
    }))
    const eventItems = filteredAgentEvents.slice(-40).map((event, index) => ({
      id: `event-${String(event.type)}-${String(event.item?.id || index)}-${index}`,
      event,
      kind: 'event' as const,
      timestamp: Number(event.timestamp || event.item?.createdAt || 0),
    }))
    return [...messageItems, ...eventItems]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-80)
  }, [filteredAgentEvents, messages])

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
    activeModuleId,
    filteredAgentEvents,
    messages,
    open,
    scrollConversationToBottom,
    selectedModuleId,
    session?.id,
  ])

  const selectModule = (moduleId: string | null) => {
    onSelectModule(moduleId)
    onFilterModule(moduleId)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!session?.id || !selectedModuleId || !text.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await sendSessionMessage(session.id, selectedModuleId, text.trim())
      if (result.message) onMessageQueued?.(result.message)
      if (result.guidanceStatus === 'queued-for-guidance') {
        setNotice('已发送引导，正在中断当前模块执行')
      }
      setText('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const className = variant === 'embedded'
    ? 'chat-drawer embedded open'
    : `chat-drawer${open ? ' open' : ''}`
  return (
    <section className={className}>
      <div className="chat-drawer-header">
        <div className="chat-drawer-heading">
          <strong className="chat-drawer-title">聊天调整</strong>
          <span className="chat-drawer-meta">{disabled ? '聊天功能已关闭' : session ? `${labelForSessionStatus(session)} · 可查看聊天记录` : '选择 session 后可查看聊天'}</span>
        </div>
        {variant === 'drawer' ? (
          <button className="icon-btn" onClick={onClose} title="关闭聊天" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
      </div>
      <ModulePicker onSelectModule={selectModule} selectedModuleId={selectedModuleId} session={session} />
      <div className="conversation-stream" ref={conversationRef}>
        {conversationItems.length ? (
          <>
            {conversationItems.map((item) => (
              item.kind === 'message'
                ? <MessageBubble key={item.id} message={item.message} />
                : <AgentEventRow event={item.event} key={item.id} />
            ))}
          </>
        ) : (
          <div className="empty-state">暂无聊天记录</div>
        )}
      </div>
      <form className={`composer${!selectedModuleId ? ' is-disabled' : ''}`} onSubmit={submit}>
        <textarea disabled={disabled || !session || !selectedModuleId} onChange={(event) => setText(event.target.value)} placeholder={selectedModuleId ? '输入调整要求…' : '选择模块后可输入调整要求'} ref={textareaRef} rows={1} value={text} />
        <div className="composer-footer">
          <span className={`composer-hint${error ? ' is-error' : notice ? ' is-notice' : ''}`}>{error || notice || (selectedModuleId ? '发送需点击按钮，Enter 不会提交' : '选择全部时仅查看记录')}</span>
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
      <div className="bubble-meta-row">
        {message.moduleId ? <span className="bubble-source">模块 {message.moduleId}</span> : null}
        {message.agentItemType === 'mcp_tool_call' ? <span className="event-tool-name">{getMessageToolName(message)}</span> : null}
      </div>
      <div className="bubble-text">{message.text}</div>
    </article>
  )
}

function AgentEventRow({ event }: { event: AgentEvent }) {
  const item = event.item
  const moduleId = getAgentEventModuleId(event)
  const title = getAgentEventTitle(event)
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

function getAgentEventTitle(event: AgentEvent) {
  const item = event.item
  const type = String(item?.type || event.type || 'agent event').trim()
  if (type === 'mcp_tool_call') {
    return [item?.server, item?.tool].map((value) => String(value || '').trim()).filter(Boolean).join('/') || type
  }
  if (type === 'command_execution') return '命令执行'
  return type
}

function getMessageToolName(message: SessionMessage) {
  const firstLine = String(message.text || '').split(/\r?\n/)[0] || ''
  const match = firstLine.match(/工具(?:\s+\S+)?\s*:\s*(.+)$/)
  return match?.[1]?.trim() || 'mcp_tool_call'
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
