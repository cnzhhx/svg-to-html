// ─── Session 日志限制 ────────────────────────────────────────
// 单条日志最大字符数
export const MAX_SESSION_LOG_CHARS = Number(
  process.env['SESSION_LOG_MAX_CHARS'] ?? 12000,
)
// session 日志条目上限
export const MAX_SESSION_LOG_ENTRIES = Number(
  process.env['SESSION_LOG_MAX_ENTRIES'] ?? 500,
)
// agent 事件输出截断长度
export const MAX_AGENT_EVENT_OUTPUT_CHARS = Number(
  process.env['SESSION_AGENT_EVENT_OUTPUT_MAX_CHARS'] ?? 100,
)
// agent 推理事件截断长度
export const MAX_AGENT_REASONING_EVENT_CHARS = Number(
  process.env['SESSION_AGENT_REASONING_EVENT_MAX_CHARS'] ?? 4000,
)

// ─── Agent 事件格式化限制 ────────────────────────────────────
// stdout 日志单条最大字符数
export const MAX_AGENT_STDOUT_LOG_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_CHARS'] ?? 100,
)
// stdout 日志最大行数
export const MAX_AGENT_STDOUT_LOG_LINES = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINES'] ?? 20,
)
// stdout 单行字符上限
export const MAX_AGENT_STDOUT_LOG_LINE_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINE_CHARS'] ?? 100,
)
// 模型调用遥测记录条数上限
export const MAX_MODEL_TELEMETRY_RECORDS = Math.max(
  0,
  Number(process.env['SESSION_MODEL_TELEMETRY_RECORDS'] ?? 200),
)
// 事件中命令输出截断长度
export const MAX_EVENT_COMMAND_OUTPUT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_OUTPUT_CHARS'] ?? 100),
)
// 事件中命令本体截断长度
export const MAX_EVENT_COMMAND_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_CHARS'] ?? 100),
)
// 事件中工具文本截断长度
export const MAX_EVENT_TOOL_TEXT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_TOOL_TEXT_CHARS'] ?? 100),
)
// 事件中推理文本截断长度
export const MAX_EVENT_REASONING_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_REASONING_CHARS'] ?? 4_000),
)
// 事件指标 chunk 间隔上限
export const MAX_EVENT_METRIC_CHUNK_GAPS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_CHUNK_GAPS'] ?? 20),
)
// 事件指标 think 采样数上限
export const MAX_EVENT_METRIC_THINK_SAMPLES = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_THINK_SAMPLES'] ?? 0),
)
