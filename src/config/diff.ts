import { getBackendConfig } from './backend.js'

// ─── Diff / 像素对比 ────────────────────────────────────────
// 全页面 diff 合格阈值
export const getDiffRatioThreshold = () =>
  getBackendConfig().diff.diffRatioThreshold
export const DIFF_RATIO_THRESHOLD = getDiffRatioThreshold()
// 单模块 diff 合格阈值
export const getModuleDiffRatioThreshold = () =>
  getBackendConfig().diff.moduleDiffRatioThreshold
export const MODULE_DIFF_RATIO_THRESHOLD = getModuleDiffRatioThreshold()
// 截图缩放倍数
export const getPngRasterScaleMultiplier = () =>
  getBackendConfig().diff.pngRasterScaleMultiplier
export const PNG_RASTER_SCALE_MULTIPLIER = getPngRasterScaleMultiplier()
