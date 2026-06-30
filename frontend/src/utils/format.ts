import type { Session } from '../types/session'

export function labelForStatus(status?: string) {
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

export function labelForSessionStatus(session?: Session | null) {
  const base = labelForStatus(session?.status)
  return session?.__localOnly ? `${base} · 本地记录` : base
}

export function labelForOutputFormat(format?: string) {
  const labels: Record<string, string> = {
    html: 'HTML',
    react: 'React',
    vue: 'Vue',
  }
  return labels[String(format || '')] || format || '未知格式'
}

export function formatElapsedDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function formatSessionDuration(session?: Session | null, now = Date.now()) {
  if (!session) return '0s'
  const start = Number(session.executionStartedAt || session.queuedAt || session.createdAt || now)
  const end =
    session.status === 'running' || session.status === 'queued'
      ? now
      : Number(session.updatedAt || now)
  return formatElapsedDuration(Math.max(0, end - start))
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

export function formatCacheTimestamp(value: unknown) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  return new Date(timestamp).toLocaleString()
}

export function toPercent(value: unknown, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return `${(n * 100).toFixed(digits)}%`
}
