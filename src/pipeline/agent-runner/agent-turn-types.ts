type AgentCommandKind = 'verify-design' | 'verify-module-design'
type AgentVerifyQualityStatus = 'pass' | 'partial' | 'fail'

type AgentCommandRecord = {
  command: string
  commandKind: AgentCommandKind
  completedAt: number
  diffRatio?: number
  exitCode: number | null
  internalRound: number
  qualityStatus?: AgentVerifyQualityStatus
  startedAt?: number
  status: 'completed' | 'failed'
}

type AgentMessageRecord = {
  internalRound: number
  text: string
  timestamp: number
}

type AgentInternalRound = {
  commands: AgentCommandRecord[]
  diffRatio?: number
  endedAt?: number
  roundNumber: number
  startedAt: number
}

type AgentVerifyUsageSummary = {
  bestDiffRatio?: number
  verifyCount: number
}

type AgentTurnSummary = {
  commands: AgentCommandRecord[]
  durationMs: number
  endedAt: number
  earlyStopReason?: string
  internalRounds: AgentInternalRound[]
  messages: AgentMessageRecord[]
  startedAt: number
  totalShellCommands?: number
  totalCommands: number
  totalInternalRounds: number
  usage: { input_tokens: number; output_tokens: number } | null
  verifyUsage: AgentVerifyUsageSummary
}

export type {
  AgentCommandKind,
  AgentCommandRecord,
  AgentInternalRound,
  AgentMessageRecord,
  AgentTurnSummary,
  AgentVerifyQualityStatus,
  AgentVerifyUsageSummary,
}
