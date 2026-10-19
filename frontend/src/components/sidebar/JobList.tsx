import { useEffect, useState } from 'react'
import type { JobSummary } from '../../types/job'
import { formatJobDuration, formatQueueWait, labelForOutputFormat, labelForJobStatus } from '../../utils/format'
import { getJobOutputFormat } from '../../utils/artifacts'

export function JobList({
  adminMode,
  currentJobId,
  onSelectJob,
  jobs,
}: {
  adminMode: boolean
  currentJobId: string | null
  onSelectJob: (id: string) => void
  jobs: JobSummary[]
}) {
  const hasLiveJobs = jobs.some((job) => job.status === 'running' || job.status === 'queued')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!hasLiveJobs) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasLiveJobs])

  if (!jobs.length) {
    return <div className="job-list"><div className="empty-state">暂无转换记录</div></div>
  }

  const ownJobs = jobs.filter((job) => !job.isShowcase && job.accessMode !== 'shared')
  const sharedJobs = jobs.filter((job) => !job.isShowcase && job.accessMode === 'shared')
  const showcaseJobs = jobs.filter((job) => job.isShowcase)

  const renderJobs = (items: JobSummary[]) => items.map((job) => {
    const active = job.id === currentJobId
    const outputFormat = labelForOutputFormat(getJobOutputFormat(job))
    const modelMeta = job.model ? ` · 模型: ${job.model}` : ''
    return (
      <button
        className={`job-item${active ? ' active' : ''}`}
        data-job-id={job.id}
        key={job.id}
        onClick={() => onSelectJob(job.id)}
        type="button"
      >
        <span className={`job-status-dot status-${job.status}`} />
        <span className="job-item-body">
          <span className="job-item-title-row">
            <span className="job-item-title">{job.designName || job.id}</span>
            {job.isShowcase ? <span className="job-showcase-badge">示例</span> : null}
          </span>
          <span className="job-item-meta">
            {formatJobDuration(job, now)} · {outputFormat}{modelMeta} · {labelForJobStatus(job)}
          </span>
          {job.status === 'queued' && job.queue ? (
            <span className="job-item-queue">
              第 {job.queue.queuePosition}/{job.queue.totalQueued} 位 · {formatQueueWait(job.queue.estimatedWaitMinutes)}
            </span>
          ) : null}
        </span>
      </button>
    )
  })

  return (
    <div className="job-list" id="jobList">
      {ownJobs.length ? <div className="job-list-section">{adminMode ? '全部转换' : '我的转换'}</div> : null}
      {renderJobs(ownJobs)}
      {sharedJobs.length ? <div className="job-list-section">共享查看</div> : null}
      {renderJobs(sharedJobs)}
      {showcaseJobs.length ? <div className="job-list-section">示例</div> : null}
      {renderJobs(showcaseJobs)}
    </div>
  )
}
