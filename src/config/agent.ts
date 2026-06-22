// ─── Agent 并发与执行控制 ────────────────────────────────────
// 同时运行的 session 数量
export const MAX_CONCURRENT_AGENTS = Number(
  process.env['MAX_CONCURRENT_AGENTS'] ??
    (process.env['NODE_ENV'] === 'production' ? 1 : 2),
)
// 单 session 内同时跑的模块 agent 数
export const MAX_PARALLEL_MODULE_AGENTS = Number(
  process.env['MAX_PARALLEL_MODULE_AGENTS'] ?? 10,
)
// 单 session 内跨模块共享的视觉模型并发上限
export const SEMANTIC_VISION_CONCURRENCY = Number(
  process.env['SEMANTIC_VISION_CONCURRENCY'] ??
    Math.min(Number(process.env['MAX_PARALLEL_MODULE_AGENTS'] ?? 10), 3),
)

// diffRatio 反弹超此值则回滚
export const AGENT_VERIFY_ROLLBACK_THRESHOLD = Number(
  process.env['AGENT_VERIFY_ROLLBACK_THRESHOLD'] ?? 0.005,
)

// ─── 超时配置 ────────────────────────────────────────────────
// 模块 agent 单次执行最长时间（毫秒）
export const MODULE_AGENT_TIMEOUT_MS = Number(
  process.env['MODULE_AGENT_TIMEOUT_MS'] ?? 3_600_000,
)
