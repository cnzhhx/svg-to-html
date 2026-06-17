import type {
  OutputFormat,
  SessionOutputTarget,
} from '../core/output-target.js'
import type { ComponentLibrarySessionRef } from '../core/component-library/types.js'

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

type SessionResult = {
  sourceEntryPath?: string
  sourceStylePath?: string
  renderEntryPath?: string
  compareEntryPath?: string
  outputTarget?: SessionOutputTarget
  designWidth?: number
  designHeight?: number
  containerLayoutPath?: string
  diffRatio?: string | number
  svgPngPath?: string
  renderPngPath?: string
  artifactDir?: string
  sourceBasis?: string
  sourceRenderMode?: string
  tokensUsed?: number
  cachedInputTokens?: number
  componentLibrary?: ComponentLibrarySessionRef
  componentLibraryId?: string
  inputTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  verifyMode?: string
  moduleAgentManifestPath?: string
  moduleAgentRuns?: Array<Record<string, unknown>>
  moduleAgentThreadIds?: Record<string, string>
  moduleValidationRuns?: Array<Record<string, unknown>>
  modelTelemetryRecords?: Array<Record<string, unknown>>
  modelUsageRecords?: Array<Record<string, unknown>>
  moduleConcurrencyLimit?: number
  moduleCount?: number
  moduleCountExceedsConcurrency?: boolean
  moduleDiffRegionsPath?: string
  moduleFailedIds?: string[]
  moduleFailureKinds?: Record<string, string>
  moduleFailures?: Record<string, string>
  modulePlanMode?: string
  moduleManifestPath?: string
  moduleMergeManifestPath?: string
  modulePlanMarkdownPath?: string
  modulePlanPath?: string
  modulePlanQualityMarkdownPath?: string
  modulePlanQualityPath?: string
  regionsPath?: string
  agentResponse?: string
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
  executionStartedAt?: number
  threadId?: string
  svgPath: string
  scale?: number
  sessionDir: string
  artifactDir: string
  componentLibrary?: ComponentLibrarySessionRef
  componentLibraryId?: string
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
  PipelineStep,
  Session,
  SessionEvent,
  SessionMessage,
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
