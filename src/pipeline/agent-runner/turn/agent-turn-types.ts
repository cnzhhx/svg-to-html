import type { AgentTurnMetrics } from '../../agent-runtime/index.js'

type AgentCommandKind =
  | 'verify-design'
  | 'verify-module-design'
  | 'verify-module-framework'
  | 'browser-eval'

type AgentCommandRecord = {
  command: string
  commandKind: AgentCommandKind
  completedAt: number
  diffRatio?: number
  exitCode: number | null
  internalRound: number
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
  rollbackCount?: number
  rollbackReasons?: string[]
}

type AgentTokenUsage = {
  cached_input_tokens?: number
  input_tokens: number
  output_tokens: number
}

type AgentTurnSummary = {
  commands: AgentCommandRecord[]
  durationMs: number
  endedAt: number
  earlyStopReason?: string
  internalRounds: AgentInternalRound[]
  messages: AgentMessageRecord[]
  metrics?: AgentTurnMetrics
  startedAt: number
  totalShellCommands?: number
  totalCommands: number
  totalInternalRounds: number
  usage: AgentTokenUsage | null
  verifyUsage: AgentVerifyUsageSummary
}

export type {
  AgentCommandKind,
  AgentCommandRecord,
  AgentInternalRound,
  AgentMessageRecord,
  AgentTokenUsage,
  AgentTurnMetrics,
  AgentTurnSummary,
}
