// ─── Diff / 像素对比 ────────────────────────────────────────
// 全页面 diff 合格阈值
export const DIFF_RATIO_THRESHOLD = Number(
  process.env['DIFF_RATIO_THRESHOLD'] ?? 0.05,
)
// 单模块 diff 合格阈值
export const MODULE_DIFF_RATIO_THRESHOLD = Number(
  process.env['MODULE_DIFF_RATIO_THRESHOLD'] ?? 0.05,
)
// 截图缩放倍数
const parsedPngRasterScaleMultiplier = Number(
  process.env['PNG_RASTER_SCALE_MULTIPLIER'] ?? 2,
)
export const PNG_RASTER_SCALE_MULTIPLIER =
  Number.isFinite(parsedPngRasterScaleMultiplier) &&
  parsedPngRasterScaleMultiplier > 0
    ? parsedPngRasterScaleMultiplier
    : 2
