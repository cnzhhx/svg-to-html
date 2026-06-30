import type { Session, WorkflowNodeKey, WorkflowProgress } from './types.js'

const WORKFLOW_NODE_LABELS: Record<WorkflowNodeKey, string> = {
  upload: '已上传',
  analysis: '结构解析',
  agent: '大模型生成',
  verify: '视觉校验',
  done: '完成',
}

const LEGACY_ANALYSIS_NODE_KEY = 'pre' + 'process'

const createWorkflowProgress = (): WorkflowProgress => ({
  currentNode: 'upload',
  detail: 'SVG 已上传，等待执行',
  iteration: 1,
  nodes: {
    upload: {
      label: WORKFLOW_NODE_LABELS.upload,
      status: 'completed',
      completedAt: Date.now(),
    },
    analysis: { label: WORKFLOW_NODE_LABELS.analysis, status: 'pending' },
    agent: { label: WORKFLOW_NODE_LABELS.agent, status: 'pending' },
    verify: { label: WORKFLOW_NODE_LABELS.verify, status: 'pending' },
    done: { label: WORKFLOW_NODE_LABELS.done, status: 'pending' },
  },
})

const isTerminalDoneStatus = (status: string) =>
  status === 'completed' || status === 'best-effort' || status === 'failed-gate'

const isInitialWorkflowProgress = (progress: WorkflowProgress) =>
  progress.currentNode === 'upload' &&
  progress.iteration === 1 &&
  progress.nodes.analysis?.status === 'pending' &&
  progress.nodes.agent?.status === 'pending' &&
  progress.nodes.verify?.status === 'pending' &&
  progress.nodes.done?.status === 'pending'

const ensureWorkflowProgress = (session: Session): WorkflowProgress => {
  // Older snapshots only had step/status fields; derive progress once when
  // the stored progress is missing or still at its untouched initial state.
  const shouldDerive =
    !session.progress ||
    (isInitialWorkflowProgress(session.progress) &&
      (session.status !== 'draft' ||
        session.activeStep !== null ||
        session.steps.agent.status !== 'pending' ||
        typeof session.result.diffRatio === 'number'))

  if (shouldDerive) {
    session.progress = deriveWorkflowProgressFromSession(session)
  }

  const progress = session.progress ?? deriveWorkflowProgressFromSession(session)
  session.progress = progress

  const legacyNodes = progress.nodes as Record<string, unknown>
  if (!progress.nodes.analysis && legacyNodes[LEGACY_ANALYSIS_NODE_KEY]) {
    progress.nodes.analysis = legacyNodes[
      LEGACY_ANALYSIS_NODE_KEY
    ] as WorkflowProgress['nodes']['analysis']
  }
  delete legacyNodes[LEGACY_ANALYSIS_NODE_KEY]
  const legacyRevisionNodeKey = 'feed' + 'back'
  delete legacyNodes[legacyRevisionNodeKey]
  const currentNode = progress.currentNode as string | null
  if (currentNode === LEGACY_ANALYSIS_NODE_KEY) {
    progress.currentNode = 'analysis'
  }
  if (currentNode === legacyRevisionNodeKey) {
    progress.currentNode = 'done'
  }

  const defaultProgress = createWorkflowProgress()
  for (const key of Object.keys(WORKFLOW_NODE_LABELS) as WorkflowNodeKey[]) {
    progress.nodes[key] = {
      ...defaultProgress.nodes[key],
      ...progress.nodes[key],
      label: WORKFLOW_NODE_LABELS[key],
    }
  }

  return progress
}

const deriveWorkflowProgressFromSession = (session: Session): WorkflowProgress => {
  const progress = createWorkflowProgress()
  const now = session.updatedAt || Date.now()
  const agentStep = session.steps.agent
  const verifyStep = session.steps.verify
  // These booleans are recovery signals for historical sessions, not fresh
  // workflow decisions; they rebuild a plausible progress bar from artifacts.
  const hasAnalysisArtifacts =
    Boolean(session.result.containerLayoutPath) ||
    Boolean(session.result.modulePlanPath)
  const hasAgentOutput =
    agentStep.status === 'completed' ||
    Boolean(session.result.agentResponse) ||
    verifyStep.status !== 'pending' ||
    isTerminalDoneStatus(session.status)
  const hasVerifyOutput =
    verifyStep.status === 'completed' ||
    typeof session.result.diffRatio === 'number' ||
    isTerminalDoneStatus(session.status)
  const analysisCompleted =
    hasAnalysisArtifacts ||
    session.activeStep !== null ||
    agentStep.status !== 'pending' ||
    verifyStep.status !== 'pending' ||
    session.status !== 'draft'

  progress.iteration = session.progress?.iteration ?? 1
  progress.maxIterations = session.progress?.maxIterations

  if (analysisCompleted) {
    progress.nodes.analysis = {
      ...progress.nodes.analysis,
      status: 'completed',
      startedAt: now,
      completedAt: now,
    }
  }

  if (hasAgentOutput) {
    progress.nodes.agent = {
      ...progress.nodes.agent,
      status: 'completed',
      startedAt: agentStep.startedAt ?? now,
      completedAt: agentStep.completedAt ?? now,
    }
  }

  if (hasVerifyOutput) {
    progress.nodes.verify = {
      ...progress.nodes.verify,
      status: 'completed',
      startedAt: verifyStep.startedAt ?? now,
      completedAt: verifyStep.completedAt ?? now,
    }
  }

  if (isTerminalDoneStatus(session.status)) {
    progress.currentNode = 'done'
    progress.detail = '所有阶段已完成，可查看结果和报告'
    progress.nodes.analysis.status = 'completed'
    progress.nodes.agent.status = 'completed'
    progress.nodes.verify.status = 'completed'
    progress.nodes.done = {
      ...progress.nodes.done,
      status: 'completed',
      startedAt: now,
      completedAt: now,
    }
    return progress
  }

  if (session.activeStep === 'verify' || verifyStep.status === 'running') {
    progress.currentNode = 'verify'
    progress.detail = '正在执行视觉校验'
    progress.nodes.verify = {
      ...progress.nodes.verify,
      status: 'running',
      startedAt: verifyStep.startedAt ?? now,
      completedAt: undefined,
    }
    return progress
  }

  if (session.activeStep === 'agent' || agentStep.status === 'running') {
    progress.currentNode = 'agent'
    progress.detail = '大模型正在生成 HTML'
    progress.nodes.agent = {
      ...progress.nodes.agent,
      status: 'running',
      startedAt: agentStep.startedAt ?? now,
      completedAt: undefined,
    }
    return progress
  }

  if (session.status === 'queued') {
    progress.currentNode = analysisCompleted ? 'agent' : 'analysis'
    progress.detail = '已进入队列，等待执行'
    progress.nodes[progress.currentNode] = {
      ...progress.nodes[progress.currentNode],
      status: 'pending',
    }
    return progress
  }

  if (session.status === 'failed') {
    if (verifyStep.status === 'failed') {
      progress.currentNode = 'verify'
      progress.nodes.verify = {
        ...progress.nodes.verify,
        status: 'failed',
        startedAt: verifyStep.startedAt ?? now,
        completedAt: verifyStep.completedAt ?? now,
        error: verifyStep.error ?? session.error,
      }
    } else if (agentStep.status === 'failed') {
      progress.currentNode = 'agent'
      progress.nodes.agent = {
        ...progress.nodes.agent,
        status: 'failed',
        startedAt: agentStep.startedAt ?? now,
        completedAt: agentStep.completedAt ?? now,
        error: agentStep.error ?? session.error,
      }
    } else if (!analysisCompleted) {
      progress.currentNode = 'analysis'
      progress.nodes.analysis = {
        ...progress.nodes.analysis,
        status: 'failed',
        startedAt: now,
        completedAt: now,
        error: session.error,
      }
    } else {
      progress.currentNode = 'verify'
      progress.nodes[progress.currentNode] = {
        ...progress.nodes[progress.currentNode],
        status: 'failed',
        startedAt: now,
        completedAt: now,
        error: session.error,
      }
    }
    progress.detail = session.error ? `执行失败：${session.error}` : '执行失败'
    return progress
  }

  if (hasVerifyOutput) {
    progress.currentNode = 'done'
    progress.detail = '结果已生成'
    progress.nodes.done = {
      ...progress.nodes.done,
      status: 'completed',
      startedAt: now,
      completedAt: now,
    }
    return progress
  }

  if (hasAgentOutput) {
    progress.currentNode = 'verify'
    progress.detail = '首轮渲染入口已生成，等待视觉校验'
    return progress
  }

  if (analysisCompleted) {
    progress.currentNode = 'agent'
    progress.detail = '结构解析完成，等待大模型生成'
    return progress
  }

  return progress
}

export {
  WORKFLOW_NODE_LABELS,
  ensureWorkflowProgress,
}
