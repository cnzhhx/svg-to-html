export const MODULE_AGENT_TIMEOUT_MS = 3_600_000
export const DIFF_RATIO_THRESHOLD = Number(
  process.env['DIFF_RATIO_THRESHOLD'] ?? 0.05,
)
export const MODULE_DIFF_RATIO_THRESHOLD = Number(
  process.env['MODULE_DIFF_RATIO_THRESHOLD'] ?? 0.05,
)
export const VISION_TEXT_TIMEOUT_MS = Number(
  process.env['VISION_TEXT_TIMEOUT_MS'] ?? 300_000,
)
// 组件库依赖安装（pnpm install）单次执行最长耗时。大组件库 / monorepo /
// 含 postinstall 脚本的依赖可能很慢甚至 hang，给个上限避免调用链永久阻塞。
// 超时后 install 会被标记为 failed，前端/merge 可重试或按失败处理。
export const COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS = Number(
  process.env['COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS'] ?? 300_000,
)
// 组件库 install 时注入的 npm registry。默认使用 npm 官方 registry，
// 可通过环境变量覆盖为其它公开镜像或私有 registry。
export const COMPONENT_LIBRARY_INSTALL_REGISTRY =
  process.env['COMPONENT_LIBRARY_INSTALL_REGISTRY'] ??
  'https://registry.npmjs.org/'
const parsedPngRasterScaleMultiplier = Number(
  process.env['PNG_RASTER_SCALE_MULTIPLIER'] ?? 2,
)
export const PNG_RASTER_SCALE_MULTIPLIER =
  Number.isFinite(parsedPngRasterScaleMultiplier) &&
  parsedPngRasterScaleMultiplier > 0
    ? parsedPngRasterScaleMultiplier
    : 2

const isTruthyFlag = (raw: string | undefined) => {
  if (raw === undefined || raw === '') return false
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

// 前端是否把 session 快照写入 localStorage / 把产物缓存进 IndexedDB。
// 默认关闭；通过环境变量 SESSION_LOCAL_STORAGE_ENABLED=1 开启。
export const SESSION_LOCAL_STORAGE_ENABLED = isTruthyFlag(
  process.env['SESSION_LOCAL_STORAGE_ENABLED'],
)
