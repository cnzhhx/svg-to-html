import type { Job } from '../types/job'

function labelForStatus(status?: string) {
  const labels: Record<string, string> = {
    draft: '待开始',
    queued: '排队中',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    'best-effort': '已完成',
    'failed-gate': '未达标',
  }
  return labels[String(status || '')] || status || '未知'
}

export function labelForJobStatus(job?: Job | null) {
  const base = labelForStatus(job?.status)
  const quality = job?.status === 'completed' && job.result?.quality?.status === 'partial' ? ' · 部分达标' : ''
  return `${base}${quality}${job?.__localOnly ? ' · 本地记录' : ''}`
}

export function labelForOutputFormat(format?: string) {
  const labels: Record<string, string> = {
    html: 'HTML',
    react: 'React',
    vue: 'Vue',
    flutter: 'Flutter',
  }
  return labels[String(format || '')] || format || '未知格式'
}

function formatElapsedDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function formatJobDuration(job?: Job | null, now = Date.now()) {
  if (!job) return '0s'
  const start = Number(job.executionStartedAt || job.queuedAt || job.createdAt || now)
  const end =
    job.status === 'running' || job.status === 'queued'
      ? now
      : Number(job.updatedAt || now)
  return formatElapsedDuration(Math.max(0, end - start))
}

export function formatQueueWait(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '即将开始'
  const rounded = Math.ceil(minutes)
  if (rounded < 60) return `约 ${rounded} 分钟`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`
}

export function formatTokenCount(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export function formatBytes(value: unknown) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function toPercent(value: unknown, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return `${(n * 100).toFixed(digits)}%`
}
