import type {
  OutputFormat,
  SessionOutputTarget,
} from '../core/output-target.js'

type PipelineStep = 'agent' | 'verify'
type WorkflowNodeKey =
  | 'upload'
  | 'analysis'
  | 'agent'
  | 'verify'
  | 'done'

type SessionStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'best-effort'
  | 'failed-gate'

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
  sourceLabel?: string
  agentEventType?: 'item.completed' | 'item.started' | 'item.updated'
  agentItemType?:
    | 'agent_message'
    | 'command_execution'
    | 'error'
    | 'mcp_tool_call'
    | 'reasoning'
}

type PendingUserMessage = {
  moduleId?: string
  text: string
}

type UploadResultFields = {
  sourceEntryPath?: string
  sourceStylePath?: string
  designWidth?: number
  designHeight?: number
  artifactDir?: string
  sourceBasis?: string
  sourceRenderMode?: string
}

type AnalysisResultFields = {
  containerLayoutPath?: string
  modulePlanPath?: string
  modulePlanMarkdownPath?: string
  modulePlanQualityPath?: string
  modulePlanQualityMarkdownPath?: string
  moduleCount?: number
  modulePlanMode?: string
  regionsPath?: string
  moduleDiffRegionsPath?: string
}

type AgentResultFields = {
  renderEntryPath?: string
  moduleAgentManifestPath?: string
  moduleAgentRuns?: Array<Record<string, unknown>>
  moduleAgentThreadIds?: Record<string, string>
  moduleValidationRuns?: Array<Record<string, unknown>>
  moduleFailedIds?: string[]
  moduleFailureKinds?: Record<string, string>
  moduleFailures?: Record<string, string>
  moduleMergeManifestPath?: string
  moduleManifestPath?: string
  moduleConcurrencyLimit?: number
  moduleCountExceedsConcurrency?: boolean
  multiAgentRoute?: boolean
  multiAgentRouteReason?: string
  agentResponse?: string
}

type VerifyResultFields = {
  diffRatio?: string | number
  svgPngPath?: string
  renderPngPath?: string
  compareEntryPath?: string
  verifyMode?: string
}

type UsageResultFields = {
  tokensUsed?: number
  cachedInputTokens?: number
  inputTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  modelTelemetryRecords?: Array<Record<string, unknown>>
  modelUsageRecords?: Array<Record<string, unknown>>
}

type SessionResult = UploadResultFields
  & AnalysisResultFields
  & AgentResultFields
  & VerifyResultFields
  & UsageResultFields
  & {
    outputTarget?: SessionOutputTarget
    textTuningAppliedCount?: number
    textTuningReportPath?: string
    workflowHistoryDir?: string
    workflowHistoryManifestPath?: string
    workflowArchives?: WorkflowArchiveEntry[]
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
  executionStartedAt?: number
  threadId?: string
  svgPath: string
  scale?: number
  sessionDir: string
  artifactDir: string
  outputFormat: OutputFormat
  outputTarget: SessionOutputTarget
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
      type: 'agent:event'
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
  AgentResultFields,
  AnalysisResultFields,
  PipelineStep,
  Session,
  SessionEvent,
  SessionMessage,
  SessionMessageRole,
  PendingUserMessage,
  SessionPersistenceState,
  SessionResult,
  SessionStatus,
  UploadResultFields,
  UsageResultFields,
  VerifyResultFields,
  WorkflowArchiveEntry,
  WorkflowArchiveItem,
  WorkflowArchiveStage,
  WorkflowNodeKey,
  WorkflowProgress,
}
