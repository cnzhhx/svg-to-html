import { getBackendConfig } from './backend.js'

// ─── Session 日志限制 ────────────────────────────────────────
// 单条日志最大字符数
export const getMaxSessionLogChars = () =>
  getBackendConfig().logging.maxSessionLogChars
// session 日志条目上限
export const getMaxSessionLogEntries = () =>
  getBackendConfig().logging.maxSessionLogEntries
// agent 事件输出截断长度
export const getMaxAgentEventOutputChars = () =>
  getBackendConfig().logging.maxAgentEventOutputChars
// agent 推理事件截断长度
export const getMaxAgentReasoningEventChars = () =>
  getBackendConfig().logging.maxAgentReasoningEventChars

// ─── Agent 事件格式化限制 ────────────────────────────────────
// stdout 日志单条最大字符数
export const getMaxAgentStdoutLogChars = () =>
  getBackendConfig().logging.maxAgentStdoutLogChars
// stdout 日志最大行数
export const getMaxAgentStdoutLogLines = () =>
  getBackendConfig().logging.maxAgentStdoutLogLines
// stdout 单行字符上限
export const getMaxAgentStdoutLogLineChars = () =>
  getBackendConfig().logging.maxAgentStdoutLogLineChars
// 模型调用遥测记录条数上限
export const getMaxModelTelemetryRecords = () =>
  getBackendConfig().logging.maxModelTelemetryRecords
// 事件中命令输出截断长度
export const getMaxEventCommandOutputChars = () =>
  getBackendConfig().logging.maxEventCommandOutputChars
// 事件中命令本体截断长度
export const getMaxEventCommandChars = () =>
  getBackendConfig().logging.maxEventCommandChars
// 事件中工具文本截断长度
export const getMaxEventToolTextChars = () =>
  getBackendConfig().logging.maxEventToolTextChars
// 事件中推理文本截断长度
export const getMaxEventReasoningChars = () =>
  getBackendConfig().logging.maxEventReasoningChars
// 事件指标 chunk 间隔上限
export const getMaxEventMetricChunkGaps = () =>
  getBackendConfig().logging.maxEventMetricChunkGaps
// 事件指标 think 采样数上限
export const getMaxEventMetricThinkSamples = () =>
  getBackendConfig().logging.maxEventMetricThinkSamples
