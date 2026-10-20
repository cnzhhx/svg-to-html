import type { Job } from '../../types/job'
import { jobDownloadUrl } from '../../api/jobs'
import { formatQueueWait } from '../../utils/format'
import { WORKFLOW_NODE_ORDER, getWorkflowProgress, labelForWorkflowNode } from '../../utils/workflow'

export function WorkflowPanel({ job, visible = true }: { job: Job | null; visible?: boolean }) {
  const progress = getWorkflowProgress(job)
  const moduleCount = Number(job?.result?.moduleCount)
  const concurrencyLimit = Number(job?.result?.moduleConcurrencyLimit ?? 5)
  const showWarning = Number.isFinite(moduleCount) && Number.isFinite(concurrencyLimit) && moduleCount > concurrencyLimit

  if (job?.status === 'queued') {
    const queue = job.queue
    return (
      <section className={`workflow-panel${visible ? ' visible' : ''}`} id="workflowPanel">
        <div className="workflow-stage-card queue-stage">
          <div className="workflow-summary">
            <span className="workflow-kicker">全局队列</span>
            <div className="workflow-summary-main">
              <strong className="workflow-current">
                {queue ? `排队第 ${queue.queuePosition} / ${queue.totalQueued} 位` : '正在获取排队位置'}
              </strong>
            </div>
            <p className="workflow-detail">
              {queue ? `前方共 ${queue.queuedAhead} 个任务，其中 ${queue.runningJobs} 个正在执行` : '队列数据会自动刷新'}
            </p>
          </div>
          {queue ? (
            <div className="queue-metrics">
              <div className="queue-metric">
                <span>预计等待</span>
                <strong>{formatQueueWait(queue.estimatedWaitMinutes)}</strong>
              </div>
              <div className="queue-metric">
                <span>单任务基准</span>
                <strong>{queue.estimatedTaskMinutes} 分钟</strong>
              </div>
              <div className="queue-metric">
                <span>执行通道</span>
                <strong>{queue.runningJobs} / {queue.maxConcurrentJobs}</strong>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section className={`workflow-panel${visible ? ' visible' : ''}`} id="workflowPanel">
      <div className="workflow-stage-card">
        <div className="workflow-summary">
          <span className="workflow-kicker">Workflow</span>
          <div className="workflow-summary-main">
            <strong className="workflow-current">{labelForWorkflowNode(progress.currentNode)}</strong>
          </div>
          <p className="workflow-detail">{progress.detail || '上传 SVG 后会显示实时进度'}</p>
          {showWarning ? (
            <div className="workflow-warning">
              模块数量 {moduleCount} 个，超过当前并发 {concurrencyLimit} 个，模块会分批执行，整体执行时间将会延长。
            </div>
          ) : null}
        </div>
        <div className="workflow-nodes">
          {WORKFLOW_NODE_ORDER.map((key) => {
            const node = progress.nodes[key]
            const isActive = key === progress.currentNode
            return (
              <div className={`workflow-node status-${node.status}${isActive ? ' active' : ''}`} key={key}>
                <span className="workflow-node-icon" aria-hidden="true" />
                <span className="workflow-node-label">{node.label}</span>
              </div>
            )
          })}
        </div>
        <div className="workflow-stage-tip">首轮生成结束后，这里会切换成完整还原度报告。</div>
        {job?.result?.diagnosticDownloadUrl && !job.__localOnly && ['failed', 'failed-gate', 'best-effort', 'completed'].includes(job.status) ? (
          <a className="link-btn" href={jobDownloadUrl(job.id, 'diagnostic')}>下载诊断包</a>
        ) : null}
      </div>
    </section>
  )
}
