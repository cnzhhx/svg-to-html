import type { Session, WorkflowNodeKey, WorkflowProgress } from '../types/session'

export const WORKFLOW_NODE_ORDER: WorkflowNodeKey[] = ['upload', 'analysis', 'agent', 'verify', 'done']

export const WORKFLOW_NODE_LABELS: Record<WorkflowNodeKey, string> = {
  upload: '已上传',
  analysis: '结构解析',
  agent: '大模型生成',
  verify: '视觉校验',
  done: '完成',
}

export function labelForWorkflowNode(node?: WorkflowNodeKey | null) {
  return node ? WORKFLOW_NODE_LABELS[node] : '等待开始'
}

export function createWorkflowProgress(): WorkflowProgress {
  return {
    currentNode: 'upload',
    detail: 'SVG 已上传，等待执行',
    iteration: 1,
    nodes: {
      upload: { label: WORKFLOW_NODE_LABELS.upload, status: 'completed' },
      analysis: { label: WORKFLOW_NODE_LABELS.analysis, status: 'pending' },
      agent: { label: WORKFLOW_NODE_LABELS.agent, status: 'pending' },
      verify: { label: WORKFLOW_NODE_LABELS.verify, status: 'pending' },
      done: { label: WORKFLOW_NODE_LABELS.done, status: 'pending' },
    },
  }
}

export function getWorkflowProgress(session?: Session | null): WorkflowProgress {
  const base = session?.progress || createWorkflowProgress()
  const fallback = createWorkflowProgress()
  return {
    ...fallback,
    ...base,
    nodes: {
      ...fallback.nodes,
      ...(base.nodes || {}),
    },
  }
}
