import { getBackendConfig } from './backend.js'

// ─── 前端缓存 ────────────────────────────────────────────────
// 是否把 session 产物缓存到 localStorage
export const getSessionLocalStorageEnabled = () =>
  getBackendConfig().session.localStorageEnabled

// ─── Session 删除控制 ────────────────────────────────────────
// 是否禁用 session 删除功能（1 = 禁用删除，前后端同时生效）
export const getSessionDeleteDisabled = () =>
  getBackendConfig().session.deleteDisabled

// ─── Session 聊天修复控制 ────────────────────────────────────
// 是否禁用 session 聊天修复功能（默认禁用；设为 0/false/no/off 可开启）
export const getSessionChatDisabled = () =>
  getBackendConfig().session.chatDisabled

// ─── 超时配置 ────────────────────────────────────────────────
// 视觉文字识别超时（毫秒）
export const getVisionTextTimeoutMs = () =>
  getBackendConfig().session.visionTextTimeoutMs

// ─── Session 消息格式化 ──────────────────────────────────────
// agent 消息采样字符数
export const getAgentMessageSampleChars = () =>
  getBackendConfig().session.agentMessageSampleChars
// agent 推理消息截断长度
export const getAgentReasoningMessageChars = () =>
  getBackendConfig().session.agentReasoningMessageChars
// archive 命令输出截断限制
export const getArchiveCommandOutputMaxChars = () =>
  getBackendConfig().session.archiveCommandOutputMaxChars
