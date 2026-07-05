import { getBackendConfig } from './backend.js'

// ─── Workflow 归档 ───────────────────────────────────────────
// 每 N 轮做一次完整归档
export const getWorkflowArchiveFullEveryN = () =>
  getBackendConfig().workflow.archiveFullEveryN
// 归档文本最大字符数
export const getWorkflowArchiveTextMaxChars = () =>
  getBackendConfig().workflow.archiveTextMaxChars

// ─── 模型规划器 ─────────────────────────────────────────────
// 规划器单轮超时（毫秒，默认 10 分钟）
export const getModelPlannerTurnTimeoutMs = () =>
  getBackendConfig().workflow.modelPlannerTurnTimeoutMs
// Mock 响应（开发/测试用，设置后跳过真实 LLM 调用）
export const getModelPlannerMockResponse = () =>
  getBackendConfig().workflow.modelPlannerMockResponse
