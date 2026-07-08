import { useEffect, useState } from 'react'
import type { JobSummary } from '../../types/job'
import { formatJobDuration, labelForOutputFormat, labelForJobStatus } from '../../utils/format'
import { getJobOutputFormat } from '../../utils/artifacts'

export function JobList({
  currentJobId,
  onSelectJob,
  jobs,
}: {
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
    return <div className="job-list"><div className="empty-state">暂无 job</div></div>
  }

  return (
    <div className="job-list" id="jobList">
      {jobs.map((job) => {
        const active = job.id === currentJobId
        const outputFormat = labelForOutputFormat(getJobOutputFormat(job))
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
              <span className="job-item-title">{job.designName || job.id}</span>
              <span className="job-item-meta">
                {formatJobDuration(job, now)} · {outputFormat} · {labelForJobStatus(job)}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
