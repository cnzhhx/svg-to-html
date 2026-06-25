type AgentReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const SUPPORTED_REASONING_EFFORTS: AgentReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

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
  support: parseReasoningEffort(
    process.env['SUPPORT_AGENT_REASONING_EFFORT'],
    'none',
  ),
} as const

export { AGENT_REASONING_EFFORTS, parseReasoningEffort }
export type { AgentReasoningEffort }
