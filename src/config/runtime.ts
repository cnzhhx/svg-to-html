// ─── 工具函数 ───────────────────────────────────────────────
const isTruthyFlag = (raw: string | undefined) => {
  if (raw === undefined || raw === '') return false
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

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

// ─── 超时配置 ────────────────────────────────────────────────
// 模块 agent 单次执行最长时间（毫秒）
export const MODULE_AGENT_TIMEOUT_MS = Number(
  process.env['MODULE_AGENT_TIMEOUT_MS'] ?? 3_600_000,
)
// 视觉文字识别超时（毫秒）
export const VISION_TEXT_TIMEOUT_MS = Number(
  process.env['VISION_TEXT_TIMEOUT_MS'] ?? 300_000,
)
// 组件库 pnpm install 超时（毫秒）
export const COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS = Number(
  process.env['COMPONENT_LIBRARY_INSTALL_TIMEOUT_MS'] ?? 300_000,
)

// ─── 组件库 ─────────────────────────────────────────────────
// 组件库安装时使用的 npm registry
export const COMPONENT_LIBRARY_INSTALL_REGISTRY =
  process.env['COMPONENT_LIBRARY_INSTALL_REGISTRY'] ??
  'https://registry.npmjs.org/'

// ─── Agent 并发与执行控制 ────────────────────────────────────
// 同时运行的 session 数量
export const MAX_CONCURRENT_AGENTS = Number(
  process.env['MAX_CONCURRENT_AGENTS'] ??
    (process.env['NODE_ENV'] === 'production' ? 1 : 2),
)
// 单 session 内同时跑的模块 agent 数
export const MAX_PARALLEL_MODULE_AGENTS = Number(
  process.env['MAX_PARALLEL_MODULE_AGENTS'] ?? 10,
)

// diffRatio 反弹超此值则回滚
export const AGENT_VERIFY_ROLLBACK_THRESHOLD = Number(
  process.env['AGENT_VERIFY_ROLLBACK_THRESHOLD'] ?? 0.005,
)

// ─── Session 日志限制 ────────────────────────────────────────
// 单条日志最大字符数
export const MAX_SESSION_LOG_CHARS = Number(
  process.env['SESSION_LOG_MAX_CHARS'] ?? 12000,
)
// session 日志条目上限
export const MAX_SESSION_LOG_ENTRIES = Number(
  process.env['SESSION_LOG_MAX_ENTRIES'] ?? 500,
)
// agent 事件输出截断长度
export const MAX_AGENT_EVENT_OUTPUT_CHARS = Number(
  process.env['SESSION_AGENT_EVENT_OUTPUT_MAX_CHARS'] ?? 100,
)
// agent 推理事件截断长度
export const MAX_AGENT_REASONING_EVENT_CHARS = Number(
  process.env['SESSION_AGENT_REASONING_EVENT_MAX_CHARS'] ?? 4000,
)

// ─── 前端缓存 ────────────────────────────────────────────────
// 是否把 session 产物缓存到 localStorage
export const SESSION_LOCAL_STORAGE_ENABLED = isTruthyFlag(
  process.env['SESSION_LOCAL_STORAGE_ENABLED'],
)

// ─── Agent 事件格式化限制 ────────────────────────────────────
// stdout 日志单条最大字符数
export const MAX_AGENT_STDOUT_LOG_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_CHARS'] ?? 100,
)
// stdout 日志最大行数
export const MAX_AGENT_STDOUT_LOG_LINES = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINES'] ?? 20,
)
// stdout 单行字符上限
export const MAX_AGENT_STDOUT_LOG_LINE_CHARS = Number(
  process.env['SESSION_AGENT_STDOUT_LOG_LINE_CHARS'] ?? 100,
)
// 模型调用遥测记录条数上限
export const MAX_MODEL_TELEMETRY_RECORDS = Math.max(
  0,
  Number(process.env['SESSION_MODEL_TELEMETRY_RECORDS'] ?? 200),
)
// 事件中命令输出截断长度
export const MAX_EVENT_COMMAND_OUTPUT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_OUTPUT_CHARS'] ?? 100),
)
// 事件中命令本体截断长度
export const MAX_EVENT_COMMAND_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_COMMAND_CHARS'] ?? 100),
)
// 事件中工具文本截断长度
export const MAX_EVENT_TOOL_TEXT_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_TOOL_TEXT_CHARS'] ?? 100),
)
// 事件中推理文本截断长度
export const MAX_EVENT_REASONING_CHARS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_REASONING_CHARS'] ?? 4_000),
)
// 事件指标 chunk 间隔上限
export const MAX_EVENT_METRIC_CHUNK_GAPS = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_CHUNK_GAPS'] ?? 20),
)
// 事件指标 think 采样数上限
export const MAX_EVENT_METRIC_THINK_SAMPLES = Math.max(
  0,
  Number(process.env['SESSION_EVENT_METRIC_THINK_SAMPLES'] ?? 0),
)

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

// ─── SVG 可见性剪裁 ─────────────────────────────────────────
// 是否开启不可见 SVG 节点剪裁（1 = 开启）
export const SVG_VISIBILITY_PRUNE_ENABLED =
  process.env['SVG_VISIBILITY_PRUNE'] === '1'
// 像素检测候选节点上限
export const SVG_VISIBILITY_PRUNE_MAX_CANDIDATES = Math.max(
  1,
  Number(process.env['SVG_VISIBILITY_PRUNE_MAX_CANDIDATES'] ?? 32),
)

// ─── Workflow 归档 ───────────────────────────────────────────
// 每 N 轮做一次完整归档
export const WORKFLOW_ARCHIVE_FULL_EVERY_N = Number(
  process.env['WORKFLOW_ARCHIVE_FULL_EVERY_N'] ?? 5,
)
// 归档文本最大字符数
export const WORKFLOW_ARCHIVE_TEXT_MAX_CHARS = Number(
  process.env['WORKFLOW_ARCHIVE_TEXT_MAX_CHARS'] ?? 12000,
)

// ─── 模型规划器 ─────────────────────────────────────────────
// 规划器单轮超时（毫秒，默认 10 分钟）
export const MODEL_PLANNER_TURN_TIMEOUT_MS = Number(
  process.env['MODEL_PLANNER_TURN_TIMEOUT_MS'] ?? 600_000,
)
// Mock 响应（开发/测试用，设置后跳过真实 LLM 调用）
export const MODEL_PLANNER_MOCK_RESPONSE: string | undefined =
  process.env['MODEL_PLANNER_MOCK_RESPONSE']

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
