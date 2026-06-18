// ─── Workflow 归档 ───────────────────────────────────────────
// 每 N 轮做一次完整归档
export const WORKFLOW_ARCHIVE_FULL_EVERY_N = Number(
  process.env['WORKFLOW_ARCHIVE_FULL_EVERY_N'] ?? 5,
)
// 归档文本最大字符数
export const WORKFLOW_ARCHIVE_TEXT_MAX_CHARS = Number(
  process.env['WORKFLOW_ARCHIVE_TEXT_MAX_CHARS'] ?? 12000,
)

// ─── 模型规划器 ─────────────────────────────────────────────
// 规划器单轮超时（毫秒，默认 10 分钟）
export const MODEL_PLANNER_TURN_TIMEOUT_MS = Number(
  process.env['MODEL_PLANNER_TURN_TIMEOUT_MS'] ?? 600_000,
)
// Mock 响应（开发/测试用，设置后跳过真实 LLM 调用）
export const MODEL_PLANNER_MOCK_RESPONSE: string | undefined =
  process.env['MODEL_PLANNER_MOCK_RESPONSE']
