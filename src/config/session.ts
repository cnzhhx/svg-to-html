import { getBackendConfig } from './backend.js'

// ─── 前端缓存 ────────────────────────────────────────────────
// 是否把 session 产物缓存到 localStorage
export const getSessionLocalStorageEnabled = () =>
  getBackendConfig().session.localStorageEnabled
export const SESSION_LOCAL_STORAGE_ENABLED = getSessionLocalStorageEnabled()

// ─── Session 删除控制 ────────────────────────────────────────
// 是否禁用 session 删除功能（1 = 禁用删除，前后端同时生效）
export const getSessionDeleteDisabled = () =>
  getBackendConfig().session.deleteDisabled
export const SESSION_DELETE_DISABLED = getSessionDeleteDisabled()

// ─── Session 聊天修复控制 ────────────────────────────────────
// 是否禁用 session 聊天修复功能（默认禁用；设为 0/false/no/off 可开启）
export const getSessionChatDisabled = () =>
  getBackendConfig().session.chatDisabled
export const SESSION_CHAT_DISABLED = getSessionChatDisabled()

// ─── 超时配置 ────────────────────────────────────────────────
// 视觉文字识别超时（毫秒）
export const getVisionTextTimeoutMs = () =>
  getBackendConfig().session.visionTextTimeoutMs
export const VISION_TEXT_TIMEOUT_MS = getVisionTextTimeoutMs()

// ─── Session 消息格式化 ──────────────────────────────────────
// agent 消息采样字符数
export const getAgentMessageSampleChars = () =>
  getBackendConfig().session.agentMessageSampleChars
export const AGENT_MESSAGE_SAMPLE_CHARS = getAgentMessageSampleChars()
// agent 推理消息截断长度
export const getAgentReasoningMessageChars = () =>
  getBackendConfig().session.agentReasoningMessageChars
export const AGENT_REASONING_MESSAGE_CHARS =
  getAgentReasoningMessageChars()
// archive 命令输出截断限制
export const getArchiveCommandOutputMaxChars = () =>
  getBackendConfig().session.archiveCommandOutputMaxChars
export const ARCHIVE_COMMAND_OUTPUT_MAX_CHARS =
  getArchiveCommandOutputMaxChars()
