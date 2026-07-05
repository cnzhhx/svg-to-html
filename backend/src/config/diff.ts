import { getBackendConfig } from './backend.js'

// ─── Diff / 像素对比 ────────────────────────────────────────
// 全页面 diff 合格阈值
export const getDiffRatioThreshold = () =>
  getBackendConfig().diff.diffRatioThreshold
// 单模块 diff 合格阈值
export const getModuleDiffRatioThreshold = () =>
  getBackendConfig().diff.moduleDiffRatioThreshold
// 截图缩放倍数
export const getPngRasterScaleMultiplier = () =>
  getBackendConfig().diff.pngRasterScaleMultiplier
