import type { Job, JobDownloadKind, JobOutputTarget } from '../types/job'
import { basePath } from '../api/http'

let runtimeArtifactRoot = ''

export function setRuntimeArtifactRoot(root: string | null | undefined) {
  runtimeArtifactRoot = String(root || '')
}

export function normalizeFsPath(value: unknown) {
  return String(value || '').replace(/\\/g, '/')
}

function artifactRelativePath(absPath: unknown) {
  const clean = normalizeFsPath(absPath)
  if (!clean) return ''
  const artifactRoot = normalizeFsPath(runtimeArtifactRoot)
  if (artifactRoot && clean.startsWith(`${artifactRoot}/`)) {
    return clean.slice(artifactRoot.length + 1)
  }
  return clean.replace(/^\/+/, '')
}

function artifactFileVersion(job?: Job | null) {
  return String(job?.updatedAt || Date.now())
}

function jobFileBaseUrl(job?: Job | null) {
  return job?.id ? `${basePath}/api/jobs/${encodeURIComponent(job.id)}/files` : `${basePath}/api/jobs`
}

export function artifactFileUrl(absPath: unknown, job?: Job | null, versionOverride?: string | number | null) {
  const relative = artifactRelativePath(absPath)
  const version = String(versionOverride ?? artifactFileVersion(job))
  return `${jobFileBaseUrl(job)}/${relative.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(version)}`
}

export function resultImageVersion(job?: Job | null) {
  const result = job?.result
  const version = [
    job?.id || '',
    result?.artifactUpdatedAt ?? '',
    artifactRelativePath(result?.renderPngPath || ''),
    artifactRelativePath(result?.svgPngPath || ''),
    result?.diffRatio ?? '',
    result?.verifyMode || '',
    artifactRelativePath(result?.outputTarget?.renderEntryPath || result?.renderEntryPath || ''),
  ].filter(Boolean).join('|')
  return version || 'stable'
}

export function getOutputTarget(job?: Job | null): JobOutputTarget | null {
  const rootTarget = job?.outputTarget
  const resultTarget = job?.result?.outputTarget
  if (rootTarget || resultTarget) return { ...(rootTarget || {}), ...(resultTarget || {}) } as JobOutputTarget
  return null
}

export function getJobOutputFormat(job?: Job | null) {
  return job?.outputFormat || getOutputTarget(job)?.format || ''
}

export function getJobDownloadKind(job: Job): JobDownloadKind {
  return job.result?.diagnosticDownloadUrl && !job.result.deliverable ? 'diagnostic' : 'deliverable'
}

export function getJobSourceEntryPath(job?: Job | null) {
  const target = getOutputTarget(job)
  return String(job?.result?.sourceEntryPath || target?.sourceEntryPath || '')
}

export function getJobRenderEntryPath(job?: Job | null) {
  const target = getOutputTarget(job)
  return String(job?.result?.renderEntryPath || target?.renderEntryPath || '')
}

export function getJobCompareEntryPath(job?: Job | null) {
  const target = getOutputTarget(job)
  return String(job?.result?.compareEntryPath || target?.compareEntryPath || '')
}

export function getJobRenderPngPath(job?: Job | null) {
  return String(job?.result?.renderPngPath || '')
}

export function getJobSourceStylePath(job?: Job | null) {
  const target = getOutputTarget(job)
  return String(job?.result?.sourceStylePath || target?.sourceStylePath || '')
}

export function getJobSvgPngPath(job?: Job | null) {
  return String(job?.result?.svgPngPath || '')
}

function getJobLivePreviewEntryPath(job?: Job | null) {
  return String(job?.result?.livePreviewEntryPath || '')
}

export function livePreviewUrl(job?: Job | null, selectedModuleId?: string | null) {
  const path = getJobLivePreviewEntryPath(job)
  if (!path) return ''
  const relative = artifactRelativePath(path)
  const version = String(job?.result?.livePreviewVersion ?? job?.result?.livePreviewUpdatedAt ?? 'stable')
  const params = new URLSearchParams({ v: version })
  if (selectedModuleId) params.set('module', selectedModuleId)
  return `${jobFileBaseUrl(job)}/${relative.split('/').map(encodeURIComponent).join('/')}?${params.toString()}`
}

export function hasPrimaryResults(job?: Job | null) {
  const result = job?.result
  const renderPngPath = result?.renderPngPath || getJobRenderPngPath(job)
  return Boolean(
    result &&
      result.finalOutputReady !== false &&
      ((result.svgPngPath && renderPngPath) || result.localArtifactCacheStatus === 'cached'),
  )
}
