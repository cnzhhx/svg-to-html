const MAX_CONCURRENT_AGENTS = Number(
  process.env['MAX_CONCURRENT_AGENTS'] ??
    (process.env['NODE_ENV'] === 'production' ? 1 : 2),
)

const MAX_PARALLEL_MODULE_AGENTS = Number(
  process.env['MAX_PARALLEL_MODULE_AGENTS'] ?? 10,
)

const MAX_AGENT_TURN_COMMANDS = Number(
  process.env['MAX_AGENT_TURN_COMMANDS'] ?? 0,
)

const MAX_AGENT_TURN_VERIFY_RUNS = Number(
  process.env['MAX_AGENT_TURN_VERIFY_RUNS'] ?? 0,
)

const MAX_AGENT_STALLED_VERIFY_RUNS = Number(
  process.env['MAX_AGENT_STALLED_VERIFY_RUNS'] ?? 0,
)

/**
 * Rollback 机制说明：
 * - 每次 verify 后，如果 diffRatio 比当前最佳值反弹超过此阈值，自动回滚到最佳备份
 * - 阈值单位：diffRatio 绝对值（如 0.005 = 0.5 个百分点）
 * - 回滚后本轮 agent 被终止，下一轮从最佳状态继续
 * - browser-eval 不产生 diffRatio，因此不会触发回滚；但首次 browser-eval 后会备份 baseline
 */
const AGENT_VERIFY_MIN_IMPROVEMENT = Number(
  process.env['AGENT_VERIFY_MIN_IMPROVEMENT'] ?? 0.001,
)

const AGENT_VERIFY_ROLLBACK_THRESHOLD = Number(
  process.env['AGENT_VERIFY_ROLLBACK_THRESHOLD'] ?? 0.005,
)

export {
  AGENT_VERIFY_MIN_IMPROVEMENT,
  AGENT_VERIFY_ROLLBACK_THRESHOLD,
  MAX_AGENT_STALLED_VERIFY_RUNS,
  MAX_AGENT_TURN_COMMANDS,
  MAX_AGENT_TURN_VERIFY_RUNS,
  MAX_CONCURRENT_AGENTS,
  MAX_PARALLEL_MODULE_AGENTS,
}
