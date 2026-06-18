// ─── CDP（Chrome DevTools Protocol） ─────────────────────────
// 单个 CDP 命令最长等待时间（毫秒）
export const CDP_SEND_TIMEOUT_MS = Number(
  process.env['CDP_SEND_TIMEOUT_MS'] ?? 120_000,
)
// 浏览器进程 ready 等待超时（毫秒）
export const CDP_READY_TIMEOUT_MS = Number(
  process.env['CDP_READY_TIMEOUT_MS'] ?? 60_000,
)
// 浏览器池空闲回收时间（毫秒）
export const BROWSER_POOL_IDLE_MS = Number(
  process.env['BROWSER_POOL_IDLE_MS'] ?? 1000,
)
// 是否禁用浏览器池复用
export const BROWSER_POOL_DISABLED =
  process.env['BROWSER_POOL_DISABLED'] === '1'

// ─── 静态文件服务器池 ────────────────────────────────────────
// 空闲回收时间（毫秒）
export const STATIC_SERVER_POOL_IDLE_MS = Number(
  process.env['STATIC_SERVER_POOL_IDLE_MS'] ?? 1000,
)
// 是否禁用静态服务器池复用
export const STATIC_SERVER_POOL_DISABLED =
  process.env['STATIC_SERVER_POOL_DISABLED'] === '1'
