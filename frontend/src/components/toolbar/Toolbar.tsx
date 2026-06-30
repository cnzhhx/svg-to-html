import type { Session } from '../../types/session'
import { getSessionOutputFormat } from '../../utils/artifacts'
import { formatSessionDuration, labelForOutputFormat, labelForSessionStatus } from '../../utils/format'
import { getWorkflowProgress, labelForWorkflowNode } from '../../utils/workflow'
import { IconButton } from '../common/IconButton'

export function Toolbar({
  chatDisabled,
  chatOpen,
  deleteDisabled,
  onDelete,
  onExpandSidebar,
  onOpenSettings,
  onToggleChat,
  onToggleTheme,
  session,
  showChatToggle = true,
  sidebarCollapsed = false,
  settingsEnabled,
}: {
  chatDisabled: boolean
  chatOpen: boolean
  deleteDisabled: boolean
  onDelete: () => void
  onExpandSidebar?: () => void
  onOpenSettings: () => void
  onToggleChat: () => void
  onToggleTheme: () => void
  session: Session | null
  showChatToggle?: boolean
  sidebarCollapsed?: boolean
  settingsEnabled: boolean
}) {
  const progress = getWorkflowProgress(session)
  const title = session?.designName || '选择一个 session'
  const meta = session
    ? `${session.id} · ${labelForSessionStatus(session)} · ${Number(session.scale || 1)}x · ${labelForOutputFormat(getSessionOutputFormat(session))} · ${formatSessionDuration(session)} · ${progress.detail || labelForWorkflowNode(progress.currentNode)}`
    : '上传 SVG 开始'

  return (
    <header className="toolbar">
      <div className="toolbar-leading">
        {sidebarCollapsed && onExpandSidebar ? (
          <IconButton className="sidebar-restore-btn" onClick={onExpandSidebar} title="展开侧边栏" aria-label="展开侧边栏">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16v16H4z" />
              <path d="M9 4v16" />
              <path d="m14 9 3 3-3 3" />
            </svg>
          </IconButton>
        ) : null}
        <div className="toolbar-left">
          <h2 className="toolbar-title">{title}</h2>
          <p className="toolbar-meta">{meta}</p>
        </div>
      </div>
      <div className="toolbar-actions">
        {session && !chatDisabled && showChatToggle ? (
          <button className={`link-btn toolbar-link-btn${chatOpen ? ' active' : ''}`} type="button" onClick={onToggleChat}>
            {chatOpen ? '收起聊天' : '打开聊天'}
          </button>
        ) : null}
        <IconButton danger disabled={!session || deleteDisabled} onClick={onDelete} title="删除 Session">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </IconButton>
        {settingsEnabled ? (
          <IconButton onClick={onOpenSettings} title="执行设置">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.36a1.7 1.7 0 0 0-1 .58V20a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-.58 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-.58-1H4a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 .58-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64a1.7 1.7 0 0 0 1-.58V4a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 .58 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9c.2.35.4.68.58 1H20a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-.52 1z" />
            </svg>
          </IconButton>
        ) : null}
        <IconButton onClick={onToggleTheme} title="切换主题">
          <svg className="theme-icon-dark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <svg className="theme-icon-light" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
          </svg>
        </IconButton>
      </div>
    </header>
  )
}
