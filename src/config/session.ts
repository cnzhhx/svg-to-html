const isTruthyFlag = (raw: string | undefined) => {
  if (raw === undefined || raw === '') return false
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

// ─── 前端缓存 ────────────────────────────────────────────────
// 是否把 session 产物缓存到 localStorage
export const SESSION_LOCAL_STORAGE_ENABLED = isTruthyFlag(
  process.env['SESSION_LOCAL_STORAGE_ENABLED'],
)

// ─── Session 删除控制 ────────────────────────────────────────
// 是否禁用 session 删除功能（1 = 禁用删除，前后端同时生效）
export const SESSION_DELETE_DISABLED = isTruthyFlag(
  process.env['SESSION_DELETE_DISABLED'],
)

// ─── Session 聊天修复控制 ────────────────────────────────────
// 是否禁用 session 聊天修复功能（默认禁用；设为 0/false/no/off 可开启）
export const SESSION_CHAT_DISABLED =
  process.env['SESSION_CHAT_DISABLED'] === undefined ||
  process.env['SESSION_CHAT_DISABLED'] === ''
    ? true
    : isTruthyFlag(process.env['SESSION_CHAT_DISABLED'])

// ─── 超时配置 ────────────────────────────────────────────────
// 视觉文字识别超时（毫秒）
export const VISION_TEXT_TIMEOUT_MS = Number(
  process.env['VISION_TEXT_TIMEOUT_MS'] ?? 300_000,
)

// ─── Session 消息格式化 ──────────────────────────────────────
// agent 消息采样字符数
export const AGENT_MESSAGE_SAMPLE_CHARS = Math.max(
  0,
  Number(process.env['SESSION_AGENT_MESSAGE_SAMPLE_CHARS'] ?? 100),
)
// agent 推理消息截断长度
export const AGENT_REASONING_MESSAGE_CHARS = Math.max(
  0,
  Number(process.env['SESSION_AGENT_REASONING_MESSAGE_CHARS'] ?? 4_000),
)
// archive 命令输出截断限制
export const ARCHIVE_COMMAND_OUTPUT_MAX_CHARS = Math.max(
  0,
  Number(process.env['ARCHIVE_COMMAND_OUTPUT_MAX_CHARS'] ?? 5000),
)
