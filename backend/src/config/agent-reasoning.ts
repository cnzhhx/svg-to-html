import {
  getBackendConfig,
  parseReasoningEffort,
} from "./backend.js";
import type { AgentReasoningEffort } from "./backend.js";

const AGENT_REASONING_EFFORTS = {
  get default() {
    return getBackendConfig().reasoning.default
  },
  get agentUnit() {
    return getBackendConfig().reasoning.agentUnit
  },
  get support() {
    return getBackendConfig().reasoning.support
  },
} as const

export { AGENT_REASONING_EFFORTS, parseReasoningEffort }
export type { AgentReasoningEffort }
