import type { SessionSummary } from '../../types/session'
import { SessionList } from './SessionList'

export function Sidebar({
  currentSessionId,
  onOpenUpload,
  onUploadFile,
  onSelectSession,
  sessions,
}: {
  currentSessionId: string | null
  onOpenUpload: () => void
  onUploadFile: (file: File) => void
  onSelectSession: (id: string) => void
  sessions: SessionSummary[]
}) {
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files?.[0]
    if (file?.name.toLowerCase().endsWith('.svg')) onUploadFile(file)
  }

  return (
    <aside className="sidebar" id="sidebar">
      <div className="brand">
        <div className="brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <path d="m10 13-2 2 2 2" />
            <path d="m14 17 2-2-2-2" />
          </svg>
        </div>
        <div className="brand-text">
          <span className="brand-name">SVG → Code</span>
        </div>
      </div>

      <button
        className="upload-zone"
        onClick={onOpenUpload}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        type="button"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>上传 SVG</span>
      </button>

      <SessionList currentSessionId={currentSessionId} onSelectSession={onSelectSession} sessions={sessions} />
    </aside>
  )
}
