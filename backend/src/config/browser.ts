import { getBackendConfig } from './backend.js'

// ─── CDP（Chrome DevTools Protocol） ─────────────────────────
// 单个 CDP 命令最长等待时间（毫秒）
export const getCdpSendTimeoutMs = () =>
  getBackendConfig().browser.cdpSendTimeoutMs
// 浏览器进程 ready 等待超时（毫秒）
export const getCdpReadyTimeoutMs = () =>
  getBackendConfig().browser.cdpReadyTimeoutMs
// 浏览器截图 / 页面 evaluate 的并发闸门
export const getCdpOperationConcurrency = () =>
  getBackendConfig().browser.cdpOperationConcurrency
// 浏览器池空闲回收时间（毫秒）
export const getBrowserPoolIdleMs = () =>
  getBackendConfig().browser.browserPoolIdleMs
// 是否禁用浏览器池复用
export const getBrowserPoolDisabled = () =>
  getBackendConfig().browser.browserPoolDisabled

// ─── 静态文件服务器池 ────────────────────────────────────────
// 空闲回收时间（毫秒）
export const getStaticServerPoolIdleMs = () =>
  getBackendConfig().browser.staticServerPoolIdleMs
// 是否禁用静态服务器池复用
export const getStaticServerPoolDisabled = () =>
  getBackendConfig().browser.staticServerPoolDisabled
