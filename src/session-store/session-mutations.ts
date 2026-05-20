import {
  WORKFLOW_NODE_LABELS,
  ensureWorkflowProgress,
} from './progress.js'
import type {
  PipelineStep,
  Session,
  SessionStatus,
  WorkflowArchiveEntry,
  WorkflowNodeKey,
  WorkflowProgress,
} from './types.js'

const setWorkflowMeta = (
  session: Session,
  patch: Partial<Pick<WorkflowProgress, 'detail' | 'iteration' | 'maxIterations'>>,
) => {
  const progress = ensureWorkflowProgress(session)
  session.progress = {
    ...progress,
    ...patch,
  }
  session.updatedAt = Date.now()
  return session.progress
}

const startWorkflowNode = (
  session: Session,
  node: WorkflowNodeKey,
  options?: {
    detail?: string
    iteration?: number
    maxIterations?: number
  },
) => {
  const progress = ensureWorkflowProgress(session)
  const currentNode = progress.nodes[node]
  session.progress = {
    ...progress,
    currentNode: node,
    detail: options?.detail ?? progress.detail,
    iteration: options?.iteration ?? progress.iteration,
    maxIterations: options?.maxIterations ?? progress.maxIterations,
    nodes: {
      ...progress.nodes,
      [node]: {
        ...currentNode,
        label: WORKFLOW_NODE_LABELS[node],
        status: 'running',
        startedAt: currentNode.startedAt ?? Date.now(),
        completedAt: undefined,
        error: undefined,
      },
    },
  }
  session.updatedAt = Date.now()
  return session.progress
}

const completeWorkflowNode = (
  session: Session,
  node: WorkflowNodeKey,
  detail?: string,
) => {
  const progress = ensureWorkflowProgress(session)
  const currentNode = progress.nodes[node]
  session.progress = {
    ...progress,
    detail: detail ?? progress.detail,
    nodes: {
      ...progress.nodes,
      [node]: {
        ...currentNode,
        label: WORKFLOW_NODE_LABELS[node],
        status: 'completed',
        startedAt: currentNode.startedAt ?? Date.now(),
        completedAt: Date.now(),
        error: undefined,
      },
    },
  }
  session.updatedAt = Date.now()
  return session.progress
}

const failWorkflowNode = (
  session: Session,
  node: WorkflowNodeKey,
  error: string,
) => {
  const progress = ensureWorkflowProgress(session)
  const currentNode = progress.nodes[node]
  session.progress = {
    ...progress,
    currentNode: node,
    detail: error ? `${WORKFLOW_NODE_LABELS[node]}失败：${error}` : progress.detail,
    nodes: {
      ...progress.nodes,
      [node]: {
        ...currentNode,
        label: WORKFLOW_NODE_LABELS[node],
        status: 'failed',
        startedAt: currentNode.startedAt ?? Date.now(),
        completedAt: Date.now(),
        error,
      },
    },
  }
  session.updatedAt = Date.now()
  return session.progress
}

const addWorkflowArchive = (session: Session, entry: WorkflowArchiveEntry) => {
  ensureWorkflowProgress(session)

  const archives = [
    ...(session.result.workflowArchives ?? []),
    entry,
  ].sort((left, right) => left.createdAt - right.createdAt)

  session.result = {
    ...session.result,
    workflowArchives: archives,
    workflowHistoryDir: entry.historyDir,
    workflowHistoryManifestPath: entry.historyManifestPath,
  }
  session.updatedAt = Date.now()
  return session.result
}

const startStep = (session: Session, step: PipelineStep) => {
  ensureWorkflowProgress(session)
  const hasExecutionStarted = Object.values(session.steps).some(
    (state) => state.status !== 'pending',
  )
  session.status = 'running'
  session.activeStep = step
  session.steps[step] = { status: 'running', startedAt: session.steps[step]?.startedAt ?? Date.now() }
  session.updatedAt = Date.now()
  return { hasExecutionStarted }
}

const completeStep = (
  session: Session,
  step: PipelineStep,
  data?: Record<string, unknown>,
) => {
  ensureWorkflowProgress(session)
  session.steps[step] = {
    ...session.steps[step],
    status: 'completed',
    completedAt: Date.now(),
  }
  session.activeStep = null
  if (data) session.result = { ...session.result, ...data }
  session.updatedAt = Date.now()
}

const failStep = (session: Session, step: PipelineStep, error: string) => {
  ensureWorkflowProgress(session)
  session.steps[step] = {
    ...session.steps[step],
    status: 'failed',
    completedAt: Date.now(),
    error,
  }
  session.activeStep = null
  session.updatedAt = Date.now()
}

const isTerminalSessionStatus = (status: string) =>
  status === 'completed' || status === 'best-effort' || status === 'failed-gate'

const markQueued = (session: Session) => {
  const wasTerminal = isTerminalSessionStatus(session.status)
  const progress = ensureWorkflowProgress(session)
  const nextProgress = wasTerminal
    ? {
        ...progress,
        currentNode: 'agent' as const,
        nodes: {
          ...progress.nodes,
          agent: {
            ...progress.nodes.agent,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
          },
          verify: {
            ...progress.nodes.verify,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
          },
          export: {
            ...progress.nodes.export,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
          },
          feedback: {
            ...progress.nodes.feedback,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
          },
          done: {
            ...progress.nodes.done,
            status: 'pending' as const,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
          },
        },
      }
    : progress
  if (wasTerminal) {
    session.activeStep = null
    session.error = undefined
    session.steps.agent = { status: 'pending' }
    session.steps.verify = { status: 'pending' }
  }
  session.status = 'queued'
  session.queuedAt = Date.now()
  session.progress = {
    ...nextProgress,
    detail: '已进入队列，等待执行',
  }
  session.updatedAt = Date.now()
  return session.progress
}

const updateQueuePosition = (
  session: Session,
  position: number,
  total: number,
) => {
  if (session.status !== 'queued') return undefined
  const detail = `排队中，第 ${position} 位（共 ${total} 个等待）`
  if (session.progress?.detail === detail) return undefined
  session.progress = { ...ensureWorkflowProgress(session), detail }
  session.updatedAt = Date.now()
  return session.progress
}

const pause = (session: Session) => {
  const now = Date.now()
  const progress = ensureWorkflowProgress(session)
  const pausedStep = session.activeStep
  if (pausedStep && session.steps[pausedStep]?.status === 'running') {
    session.steps[pausedStep] = {
      ...session.steps[pausedStep],
      status: 'pending',
      completedAt: now,
      error: undefined,
    }
  }
  session.activeStep = null
  const currentNode = progress.currentNode
  const nextNodes = { ...progress.nodes }
  if (currentNode && nextNodes[currentNode]?.status === 'running') {
    nextNodes[currentNode] = {
      ...nextNodes[currentNode],
      status: 'pending',
      completedAt: now,
      error: undefined,
    }
  }
  session.status = 'paused'
  session.progress = {
    ...progress,
    nodes: nextNodes,
    detail: progress.currentNode
      ? `${WORKFLOW_NODE_LABELS[progress.currentNode]}已暂停`
      : '执行已暂停',
  }
  session.updatedAt = now
  return session.progress
}

const completePipeline = (
  session: Session,
  options?: {
    detail?: string
    status?: Extract<SessionStatus, 'completed'>
  },
) => {
  const progress = ensureWorkflowProgress(session)
  session.status = options?.status ?? 'completed'
  session.error = undefined
  if (progress.nodes.feedback.status !== 'failed') {
    progress.nodes.feedback = {
      ...progress.nodes.feedback,
      status: 'completed',
      startedAt: progress.nodes.feedback.startedAt ?? Date.now(),
      completedAt: Date.now(),
    }
  }
  if (progress.nodes.export.status !== 'failed') {
    progress.nodes.export = {
      ...progress.nodes.export,
      status: 'completed',
      startedAt: progress.nodes.export.startedAt ?? Date.now(),
      completedAt: Date.now(),
      error: undefined,
    }
  }
  session.progress = {
    ...progress,
    currentNode: 'done',
    detail: options?.detail ?? '所有阶段已完成，可查看结果和报告',
    nodes: {
      ...progress.nodes,
      done: {
        ...progress.nodes.done,
        label: WORKFLOW_NODE_LABELS.done,
        status: 'completed',
        startedAt: progress.nodes.done.startedAt ?? Date.now(),
        completedAt: Date.now(),
        error: undefined,
      },
    },
  }
  session.updatedAt = Date.now()
  return session.progress
}

const failPipeline = (session: Session, error: string) => {
  const progress = ensureWorkflowProgress(session)
  const now = Date.now()
  const activeStep = session.activeStep
  const currentNode = progress.currentNode
  const nextNodes = { ...progress.nodes }

  if (activeStep && session.steps[activeStep]?.status === 'running') {
    session.steps[activeStep] = {
      ...session.steps[activeStep],
      status: 'failed',
      completedAt: now,
      error,
    }
  }

  if (currentNode && nextNodes[currentNode]?.status === 'running') {
    nextNodes[currentNode] = {
      ...nextNodes[currentNode],
      label: WORKFLOW_NODE_LABELS[currentNode],
      status: 'failed',
      startedAt: nextNodes[currentNode].startedAt ?? now,
      completedAt: now,
      error,
    }
  }

  session.status = 'failed'
  session.activeStep = null
  session.error = error
  session.progress = {
    ...progress,
    nodes: nextNodes,
    detail: error ? `执行失败：${error}` : '执行失败',
  }
  session.updatedAt = now
  return session.progress
}

export {
  addWorkflowArchive,
  completePipeline,
  completeStep,
  completeWorkflowNode,
  failPipeline,
  failStep,
  failWorkflowNode,
  markQueued,
  pause,
  setWorkflowMeta,
  startStep,
  startWorkflowNode,
  updateQueuePosition,
}
