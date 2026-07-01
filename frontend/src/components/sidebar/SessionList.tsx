import { useEffect, useState } from 'react'
import type { SessionSummary } from '../../types/session'
import { formatSessionDuration, labelForOutputFormat, labelForSessionStatus } from '../../utils/format'
import { getSessionOutputFormat } from '../../utils/artifacts'

export function SessionList({
  currentSessionId,
  onSelectSession,
  sessions,
}: {
  currentSessionId: string | null
  onSelectSession: (id: string) => void
  sessions: SessionSummary[]
}) {
  const hasLiveSessions = sessions.some((session) => session.status === 'running' || session.status === 'queued')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!hasLiveSessions) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasLiveSessions])

  if (!sessions.length) {
    return <div className="session-list"><div className="empty-state">暂无 session</div></div>
  }

  return (
    <div className="session-list" id="sessionList">
      {sessions.map((session) => {
        const active = session.id === currentSessionId
        const outputFormat = labelForOutputFormat(getSessionOutputFormat(session))
        return (
          <button
            className={`session-item${active ? ' active' : ''}`}
            data-session-id={session.id}
            key={session.id}
            onClick={() => onSelectSession(session.id)}
            type="button"
          >
            <span className={`session-status-dot status-${session.status}`} />
            <span className="session-item-body">
              <span className="session-item-title">{session.designName || session.id}</span>
              <span className="session-item-meta">
                {formatSessionDuration(session, now)} · {outputFormat} · {labelForSessionStatus(session)}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
