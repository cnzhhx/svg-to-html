import type { Session } from '../../types/session'
import { WORKFLOW_NODE_ORDER, getWorkflowProgress, labelForWorkflowNode } from '../../utils/workflow'

export function WorkflowPanel({ session, visible = true }: { session: Session | null; visible?: boolean }) {
  const progress = getWorkflowProgress(session)
  const moduleCount = Number(session?.result?.moduleCount)
  const concurrencyLimit = Number(session?.result?.moduleConcurrencyLimit ?? 5)
  const showWarning = Number.isFinite(moduleCount) && Number.isFinite(concurrencyLimit) && moduleCount > concurrencyLimit

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
      </div>
    </section>
  )
}
