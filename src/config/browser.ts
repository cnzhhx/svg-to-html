import { getBackendConfig } from './backend.js'

// ─── CDP（Chrome DevTools Protocol） ─────────────────────────
// 单个 CDP 命令最长等待时间（毫秒）
export const getCdpSendTimeoutMs = () =>
  getBackendConfig().browser.cdpSendTimeoutMs
export const CDP_SEND_TIMEOUT_MS = getCdpSendTimeoutMs()
// 浏览器进程 ready 等待超时（毫秒）
export const getCdpReadyTimeoutMs = () =>
  getBackendConfig().browser.cdpReadyTimeoutMs
export const CDP_READY_TIMEOUT_MS = getCdpReadyTimeoutMs()
// 浏览器截图 / 页面 evaluate 的并发闸门
export const getCdpOperationConcurrency = () =>
  getBackendConfig().browser.cdpOperationConcurrency
export const CDP_OPERATION_CONCURRENCY = getCdpOperationConcurrency()
// 浏览器池空闲回收时间（毫秒）
export const getBrowserPoolIdleMs = () =>
  getBackendConfig().browser.browserPoolIdleMs
export const BROWSER_POOL_IDLE_MS = getBrowserPoolIdleMs()
// 是否禁用浏览器池复用
export const getBrowserPoolDisabled = () =>
  getBackendConfig().browser.browserPoolDisabled
export const BROWSER_POOL_DISABLED = getBrowserPoolDisabled()

// ─── 静态文件服务器池 ────────────────────────────────────────
// 空闲回收时间（毫秒）
export const getStaticServerPoolIdleMs = () =>
  getBackendConfig().browser.staticServerPoolIdleMs
export const STATIC_SERVER_POOL_IDLE_MS = getStaticServerPoolIdleMs()
// 是否禁用静态服务器池复用
export const getStaticServerPoolDisabled = () =>
  getBackendConfig().browser.staticServerPoolDisabled
export const STATIC_SERVER_POOL_DISABLED = getStaticServerPoolDisabled()
