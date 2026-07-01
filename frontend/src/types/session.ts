export type OutputFormat = 'html' | 'vue' | 'react'

export type PipelineStep = 'agent' | 'verify'
export type WorkflowNodeKey = 'upload' | 'analysis' | 'agent' | 'verify' | 'done'
export type SessionStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'best-effort'
  | 'failed-gate'

export type StepState = {
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: string
}

export type WorkflowNodeState = StepState & {
  label: string
}

export type WorkflowProgress = {
  currentNode: WorkflowNodeKey | null
  detail?: string
  iteration: number
  maxIterations?: number
  nodes: Record<WorkflowNodeKey, WorkflowNodeState>
}

export type SessionMessage = {
  id: string
  role: 'system' | 'user' | 'assistant'
  text: string
  kind: 'chat' | 'event'
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

export type SessionOutputTarget = {
  compareEntryPath: string
  format: OutputFormat
  frameworkBuildDir?: string
  renderEntryPath: string
  sourceEntryPath: string
  sourceStylePath?: string
}

export type SessionResult = Record<string, unknown> & {
  artifactDir?: string
  compareEntryPath?: string
  designHeight?: number
  designWidth?: number
  diffRatio?: number | string
  inputTokens?: number
  cachedInputTokens?: number
  localArtifactCacheAt?: number
  localArtifactCacheByteSize?: number
  localArtifactCacheError?: string
  localArtifactCacheFileCount?: number
  localArtifactCachePaths?: string[]
  localArtifactCacheStatus?: 'cached' | 'caching' | 'error'
  livePreviewEntryPath?: string
  livePreviewUpdatedAt?: number
  livePreviewVersion?: number
  moduleActiveIds?: string[]
  moduleAgentRuns?: ModuleAgentRun[]
  moduleAgentThreadIds?: Record<string, string>
  moduleConcurrencyLimit?: number
  moduleCount?: number
  moduleFailedIds?: string[]
  modulePlanModules?: ModulePlanModule[]
  outputTarget?: SessionOutputTarget
  outputTokens?: number
  renderEntryPath?: string
  renderPngPath?: string
  sourceEntryPath?: string
  sourceStylePath?: string
  svgPngPath?: string
  tokensUsed?: number
  uncachedInputTokens?: number
}

export type Region = {
  x?: number
  y?: number
  width?: number
  height?: number
}

export type ModuleAgentRun = {
  id?: string
  status?: string
  region?: Region
  finalDiffRatio?: number
  startedAt?: number
  endedAt?: number
  error?: string
  threadId?: string
  outputPaths?: Record<string, string | undefined>
}

export type ModulePlanModule = {
  id: string
  kind?: string
  region?: Region
}

export type Session = {
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
  outputTarget?: SessionOutputTarget
  status: SessionStatus
  activeStep: PipelineStep | null
  steps: Record<PipelineStep, StepState>
  result: SessionResult
  error?: string
  logs: string[]
  messages: SessionMessage[]
  pendingUserMessages?: unknown[]
  progress?: WorkflowProgress
  createdAt: number
  updatedAt: number
  __localOnly?: boolean
  __summary?: boolean
  localOwnerId?: string
  runtimeSettings?: unknown
}

export type SessionSummary = Session
