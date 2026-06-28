import { getBackendConfig } from './backend.js'

// ─── Agent 并发与执行控制 ────────────────────────────────────
// 同时运行的 session 数量
export const getMaxConcurrentAgents = () =>
  getBackendConfig().agent.maxConcurrentAgents
export const MAX_CONCURRENT_AGENTS = getMaxConcurrentAgents()
// 单 session 内同时跑的模块 agent 数
export const getMaxParallelModuleAgents = () =>
  getBackendConfig().agent.maxParallelModuleAgents
export const MAX_PARALLEL_MODULE_AGENTS = getMaxParallelModuleAgents()
// 单 session 内跨模块共享的视觉模型并发上限
export const getSemanticVisionConcurrency = () =>
  getBackendConfig().agent.semanticVisionConcurrency
export const SEMANTIC_VISION_CONCURRENCY = getSemanticVisionConcurrency()

// diffRatio 反弹超此值则回滚
export const getAgentVerifyRollbackThreshold = () =>
  getBackendConfig().agent.verifyRollbackThreshold
export const AGENT_VERIFY_ROLLBACK_THRESHOLD =
  getAgentVerifyRollbackThreshold()

// ─── 超时配置 ────────────────────────────────────────────────
// 模块 agent 单次执行最长时间（毫秒）
export const getModuleAgentTimeoutMs = () =>
  getBackendConfig().agent.moduleTimeoutMs
export const MODULE_AGENT_TIMEOUT_MS = getModuleAgentTimeoutMs()
