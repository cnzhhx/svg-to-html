import type { JobSummary } from '../../types/job'
import type { UploadQuota } from '../../types/runtime'
import { JobList } from './JobList'

export function Sidebar({
  adminMode,
  quotaEnabled,
  initialized,
  currentJobId,
  onCollapse,
  onOpenUpload,
  onExitAdmin,
  onUploadFile,
  onSelectJob,
  jobs,
  uploadQuota,
}: {
  adminMode: boolean
  quotaEnabled: boolean
  initialized: boolean
  currentJobId: string | null
  onCollapse: () => void
  onOpenUpload: () => void
  onExitAdmin: () => void
  onUploadFile: (file: File) => void
  onSelectJob: (id: string) => void
  jobs: JobSummary[]
  uploadQuota: UploadQuota | null
}) {
  const uploadDisabled = !adminMode && quotaEnabled && Number(uploadQuota?.remaining ?? 0) < 1

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    if (uploadDisabled) return
    const file = event.dataTransfer.files?.[0]
    if (file?.name.toLowerCase().endsWith('.svg')) onUploadFile(file)
  }

  return (
    <aside className="sidebar" id="sidebar">
      <div className="brand">
        <div className="brand-main">
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
        <button className="sidebar-collapse-btn" onClick={onCollapse} type="button" aria-label="收起侧边栏" title="收起侧边栏">
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16v16H4z" />
            <path d="M9 4v16" />
            <path d="m16 9-3 3 3 3" />
          </svg>
        </button>
      </div>

      <button
        className="upload-zone"
        disabled={uploadDisabled}
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
      {adminMode ? (
        <div className="admin-mode-status">
          <strong>管理员模式</strong>
          <button onClick={onExitAdmin} type="button">退出</button>
        </div>
      ) : quotaEnabled ? (
        <div className="upload-quota">
          今日剩余 <strong>{uploadQuota?.remaining ?? 0}</strong> / {uploadQuota?.limit ?? 5} 次
        </div>
      ) : <div className="upload-quota">不限上传次数</div>}

      <JobList adminMode={adminMode} currentJobId={currentJobId} onSelectJob={onSelectJob} jobs={jobs} />
      <a className="sidebar-admin-link" href={adminMode ? '/transformer/admin/settings' : initialized ? '/transformer/login' : '/transformer/setup'}>{adminMode ? '运营设置' : initialized ? '管理员登录' : '初始化管理账号'}</a>
    </aside>
  )
}
