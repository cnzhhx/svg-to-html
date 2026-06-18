// ─── SVG 可见性剪裁 ─────────────────────────────────────────
// 是否开启不可见 SVG 节点剪裁（1 = 开启）
export const SVG_VISIBILITY_PRUNE_ENABLED =
  process.env['SVG_VISIBILITY_PRUNE'] === '1'
// 像素检测候选节点上限
export const SVG_VISIBILITY_PRUNE_MAX_CANDIDATES = Math.max(
  1,
  Number(process.env['SVG_VISIBILITY_PRUNE_MAX_CANDIDATES'] ?? 32),
)
