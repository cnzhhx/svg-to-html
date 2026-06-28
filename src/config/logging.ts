import { getBackendConfig } from './backend.js'

// ─── Session 日志限制 ────────────────────────────────────────
// 单条日志最大字符数
export const getMaxSessionLogChars = () =>
  getBackendConfig().logging.maxSessionLogChars
export const MAX_SESSION_LOG_CHARS = getMaxSessionLogChars()
// session 日志条目上限
export const getMaxSessionLogEntries = () =>
  getBackendConfig().logging.maxSessionLogEntries
export const MAX_SESSION_LOG_ENTRIES = getMaxSessionLogEntries()
// agent 事件输出截断长度
export const getMaxAgentEventOutputChars = () =>
  getBackendConfig().logging.maxAgentEventOutputChars
export const MAX_AGENT_EVENT_OUTPUT_CHARS = getMaxAgentEventOutputChars()
// agent 推理事件截断长度
export const getMaxAgentReasoningEventChars = () =>
  getBackendConfig().logging.maxAgentReasoningEventChars
export const MAX_AGENT_REASONING_EVENT_CHARS =
  getMaxAgentReasoningEventChars()

// ─── Agent 事件格式化限制 ────────────────────────────────────
// stdout 日志单条最大字符数
export const getMaxAgentStdoutLogChars = () =>
  getBackendConfig().logging.maxAgentStdoutLogChars
export const MAX_AGENT_STDOUT_LOG_CHARS = getMaxAgentStdoutLogChars()
// stdout 日志最大行数
export const getMaxAgentStdoutLogLines = () =>
  getBackendConfig().logging.maxAgentStdoutLogLines
export const MAX_AGENT_STDOUT_LOG_LINES = getMaxAgentStdoutLogLines()
// stdout 单行字符上限
export const getMaxAgentStdoutLogLineChars = () =>
  getBackendConfig().logging.maxAgentStdoutLogLineChars
export const MAX_AGENT_STDOUT_LOG_LINE_CHARS =
  getMaxAgentStdoutLogLineChars()
// 模型调用遥测记录条数上限
export const getMaxModelTelemetryRecords = () =>
  getBackendConfig().logging.maxModelTelemetryRecords
export const MAX_MODEL_TELEMETRY_RECORDS = getMaxModelTelemetryRecords()
// 事件中命令输出截断长度
export const getMaxEventCommandOutputChars = () =>
  getBackendConfig().logging.maxEventCommandOutputChars
export const MAX_EVENT_COMMAND_OUTPUT_CHARS =
  getMaxEventCommandOutputChars()
// 事件中命令本体截断长度
export const getMaxEventCommandChars = () =>
  getBackendConfig().logging.maxEventCommandChars
export const MAX_EVENT_COMMAND_CHARS = getMaxEventCommandChars()
// 事件中工具文本截断长度
export const getMaxEventToolTextChars = () =>
  getBackendConfig().logging.maxEventToolTextChars
export const MAX_EVENT_TOOL_TEXT_CHARS = getMaxEventToolTextChars()
// 事件中推理文本截断长度
export const getMaxEventReasoningChars = () =>
  getBackendConfig().logging.maxEventReasoningChars
export const MAX_EVENT_REASONING_CHARS = getMaxEventReasoningChars()
// 事件指标 chunk 间隔上限
export const getMaxEventMetricChunkGaps = () =>
  getBackendConfig().logging.maxEventMetricChunkGaps
export const MAX_EVENT_METRIC_CHUNK_GAPS = getMaxEventMetricChunkGaps()
// 事件指标 think 采样数上限
export const getMaxEventMetricThinkSamples = () =>
  getBackendConfig().logging.maxEventMetricThinkSamples
export const MAX_EVENT_METRIC_THINK_SAMPLES =
  getMaxEventMetricThinkSamples()
