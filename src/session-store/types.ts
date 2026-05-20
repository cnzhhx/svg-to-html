type PipelineStep = 'agent' | 'verify'
type OutputFormat = 'html' | 'react' | 'vue'
type FrameworkExportTarget = 'react' | 'vue'
type WorkflowNodeKey =
  | 'upload'
  | 'analysis'
  | 'agent'
  | 'verify'
  | 'export'
  | 'feedback'
  | 'done'

type SessionStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'

type StepState = {
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: string
}

type WorkflowNodeState = StepState & {
  label: string
}

type WorkflowProgress = {
  currentNode: null | WorkflowNodeKey
  detail?: string
  iteration: number
  maxIterations?: number
  nodes: Record<WorkflowNodeKey, WorkflowNodeState>
}

type WorkflowArchiveStage = 'analysis' | 'agent' | 'agent-command' | 'verify'

type WorkflowArchiveItem = {
  kind: 'file' | 'json' | 'text'
  label: string
  path: string
  sourcePath?: string
}

type WorkflowArchiveEntry = {
  id: string
  round: number
  stage: WorkflowArchiveStage
  dir: string
  historyDir: string
  historyManifestPath: string
  manifestPath: string
  createdAt: number
  diffRatio?: number
  note?: string
  metadata?: Record<string, unknown>
  items: WorkflowArchiveItem[]
}

type SessionMessageRole = 'system' | 'user' | 'assistant'
type SessionMessageKind = 'chat' | 'event'

type SessionMessage = {
  id: string
  role: SessionMessageRole
  text: string
  kind: SessionMessageKind
  createdAt: number
  moduleId?: string
  codexEventType?: 'item.completed' | 'item.started' | 'item.updated'
  codexItemType?: 'agent_message' | 'error' | 'reasoning'
}

type PendingUserMessage = {
  moduleId?: string
  text: string
}

type FrameworkExportResult = {
  assetManifestPath?: string
  assets?: unknown[]
  componentPaths?: string[]
  cssPath?: string
  dir: string
  error?: string
  previewHtmlPath?: string
  repeatComponentCount?: number
  status: 'completed' | 'failed' | 'skipped'
  target: FrameworkExportTarget
  verifyResult?: unknown
}

type SessionResult = {
  htmlPath?: string
  compareHtmlPath?: string
  containerLayoutPath?: string
  diffRatio?: string | number
  svgPngPath?: string
  htmlPngPath?: string
  diffPngPath?: string
  artifactDir?: string
  layoutBoxPassed?: boolean
  workflowLintPassed?: boolean
  finalOutputPolicyPassed?: boolean
  finalOutputPolicyPath?: string
  finalOutputReady?: boolean
  globalRepairRollbackReason?: string
  globalRepairRolledBack?: boolean
  agentTimeoutMs?: number
  tokensUsed?: number
  inputTokens?: number
  outputTokens?: number
  textBoxReportPath?: string
  layoutBoxReportPath?: string
  verifyReportPath?: string
  verifyMode?: string
  qualityStatus?: 'pass' | 'partial' | 'fail'
  qualityGateSummary?: Record<string, unknown>
  qualityBlockingIssues?: string[]
  qualitySoftIssues?: string[]
  fontRenderingLimitLikely?: boolean
  fontRenderingLimitReason?: string
  textInsightsPath?: string
  textContentPriorityIssueCount?: number
  textGeometryPriorityIssueCount?: number
  textPriorityIssueCount?: number
  workflowLintPath?: string
  frameworkExports?: Partial<Record<FrameworkExportTarget, FrameworkExportResult>>
  moduleAgentManifestPath?: string
  moduleAgentRuns?: Array<Record<string, unknown>>
  moduleValidationRuns?: Array<Record<string, unknown>>
  moduleConcurrencyLimit?: number
  moduleCount?: number
  moduleCountExceedsConcurrency?: boolean
  moduleDiffRegionsPath?: string
  moduleFailedIds?: string[]
  moduleFailures?: Record<string, string>
  modulePlanMode?: string
  moduleManifestPath?: string
  moduleMergeManifestPath?: string
  modulePlanMarkdownPath?: string
  modulePlanPath?: string
  modulePlanQualityMarkdownPath?: string
  modulePlanQualityPath?: string
  moduleTextLayoutMissingSelectorCount?: number
  moduleTextLayoutSelectorCheckPassed?: boolean
  moduleRegionStats?: Array<Record<string, unknown>>
  moduleRegionSummary?: Record<string, unknown>
  moduleRegionsPath?: string
  moduleDomReconcileMarkdownPath?: string
  moduleDomReconcilePath?: string
  moduleDomReconcileSummary?: Record<string, unknown>
  moduleRegionDiffFailures?: Array<Record<string, unknown>>
  moduleRegionDiffPassed?: boolean
  moduleRegionDiffThreshold?: number
  regionsPath?: string
  shellAssetDir?: string
  shellManifestPath?: string
  agentResponse?: string
  ocrProvider?: string
  workflowHistoryDir?: string
  workflowHistoryManifestPath?: string
  workflowArchives?: WorkflowArchiveEntry[]
  multiAgentRoute?: boolean
  multiAgentRouteReason?: string
  textTuningAppliedCount?: number
  textTuningReportPath?: string
}

type SessionPersistenceState = {
  errorCount: number
  lastErrorAt?: number
  lastErrorMessage?: string
  lastErrorPath?: string
  lastSuccessAt?: number
}

type Session = {
  id: string
  designName: string
  queuedAt?: number
  threadId?: string
  svgPath: string
  scale?: number
  htmlPath: string
  compareHtmlPath: string
  sessionDir: string
  artifactDir: string
  outputFormats?: OutputFormat[]
  status: SessionStatus
  activeStep: null | PipelineStep
  steps: Record<PipelineStep, StepState>
  result: SessionResult
  error?: string
  logs: string[]
  messages: SessionMessage[]
  pendingUserMessages: Array<string | PendingUserMessage>
  progress?: WorkflowProgress
  persistence?: SessionPersistenceState
  createdAt: number
  updatedAt: number
}

type SessionEvent =
  | {
      type: 'init'
      session: Session
      timestamp: number
    }
  | {
      type: 'session:updated'
      sessionId: string
      data: Partial<Session>
      timestamp: number
    }
  | {
      type: 'session:deleted'
      sessionId: string
      timestamp: number
    }
  | {
      type: 'step:start' | 'step:complete' | 'step:error'
      sessionId: string
      step: PipelineStep
      message?: string
      data?: Record<string, unknown>
      timestamp: number
    }
  | {
      type: 'message'
      sessionId: string
      message: SessionMessage
      timestamp: number
    }
  | {
      type: 'log'
      sessionId: string
      message: string
      timestamp: number
    }
  | {
      type: 'codex:event'
      sessionId: string
      event: Record<string, unknown>
      timestamp: number
    }
  | {
      type: 'pipeline:complete' | 'pipeline:error'
      sessionId: string
      message?: string
      timestamp: number
    }

export type {
  FrameworkExportResult,
  FrameworkExportTarget,
  OutputFormat,
  PipelineStep,
  Session,
  SessionEvent,
  SessionMessage,
  SessionMessageKind,
  SessionMessageRole,
  PendingUserMessage,
  SessionPersistenceState,
  SessionResult,
  SessionStatus,
  WorkflowArchiveEntry,
  WorkflowArchiveItem,
  WorkflowArchiveStage,
  WorkflowNodeKey,
  WorkflowProgress,
}
