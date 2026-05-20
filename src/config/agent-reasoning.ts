import type { ThreadOptions } from '@openai/codex-sdk'

type AgentReasoningEffort = NonNullable<ThreadOptions['modelReasoningEffort']>

const SUPPORTED_REASONING_EFFORTS: AgentReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
]

const parseReasoningEffort = (
  value: string | undefined,
  fallback: AgentReasoningEffort,
): AgentReasoningEffort => {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized &&
    SUPPORTED_REASONING_EFFORTS.includes(normalized as AgentReasoningEffort)
  ) {
    return normalized as AgentReasoningEffort
  }
  return fallback
}

const AGENT_REASONING_EFFORTS = {
  default: parseReasoningEffort(
    process.env['DEFAULT_AGENT_REASONING_EFFORT'],
    'high',
  ),
  agentUnit: parseReasoningEffort(
    process.env['AGENT_UNIT_REASONING_EFFORT'],
    'high',
  ),
  globalRepair: parseReasoningEffort(
    process.env['GLOBAL_REPAIR_REASONING_EFFORT'],
    'high',
  ),
} as const

export { AGENT_REASONING_EFFORTS, parseReasoningEffort }
export type { AgentReasoningEffort }
