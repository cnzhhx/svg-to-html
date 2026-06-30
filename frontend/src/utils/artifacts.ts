import type { Session, SessionOutputTarget } from '../types/session'
import { basePath } from '../api/http'

let runtimeWorkspaceRoot = ''

export function setRuntimeWorkspaceRoot(root: string | null | undefined) {
  runtimeWorkspaceRoot = String(root || '')
}

export function normalizeFsPath(value: unknown) {
  return String(value || '').replace(/\\/g, '/')
}

export function workspaceRelativePath(absPath: unknown) {
  const clean = normalizeFsPath(absPath)
  if (!clean) return ''
  const workspaceRoot = normalizeFsPath(runtimeWorkspaceRoot)
  if (workspaceRoot && clean.startsWith(`${workspaceRoot}/`)) {
    return clean.slice(workspaceRoot.length + 1)
  }
  const parts = clean.split('workspace/')
  if (parts.length > 1) return parts[parts.length - 1] || ''
  return clean.replace(/^\/+/, '')
}

export function workspaceFileVersion(session?: Session | null) {
  return String(session?.updatedAt || Date.now())
}

export function workspaceFileUrl(absPath: unknown, session?: Session | null) {
  const relative = workspaceRelativePath(absPath)
  const version = workspaceFileVersion(session)
  return `${basePath}/files/${relative.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(version)}`
}

export function getOutputTarget(session?: Session | null): SessionOutputTarget | null {
  const rootTarget = session?.outputTarget
  const resultTarget = session?.result?.outputTarget
  if (rootTarget || resultTarget) return { ...(rootTarget || {}), ...(resultTarget || {}) } as SessionOutputTarget
  return null
}

export function getSessionOutputFormat(session?: Session | null) {
  return session?.outputFormat || getOutputTarget(session)?.format || ''
}

export function getSessionSourceEntryPath(session?: Session | null) {
  const target = getOutputTarget(session)
  return String(session?.result?.sourceEntryPath || target?.sourceEntryPath || '')
}

export function getSessionRenderEntryPath(session?: Session | null) {
  const target = getOutputTarget(session)
  return String(session?.result?.renderEntryPath || target?.renderEntryPath || '')
}

export function getSessionCompareEntryPath(session?: Session | null) {
  const target = getOutputTarget(session)
  return String(session?.result?.compareEntryPath || target?.compareEntryPath || '')
}

export function getSessionRenderPngPath(session?: Session | null) {
  return String(session?.result?.renderPngPath || '')
}

export function getSessionSourceStylePath(session?: Session | null) {
  const target = getOutputTarget(session)
  return String(session?.result?.sourceStylePath || target?.sourceStylePath || '')
}

export function getSessionSvgPngPath(session?: Session | null) {
  return String(session?.result?.svgPngPath || '')
}

export function getSessionLivePreviewEntryPath(session?: Session | null) {
  return String(session?.result?.livePreviewEntryPath || '')
}

export function livePreviewUrl(session?: Session | null, selectedModuleId?: string | null) {
  const path = getSessionLivePreviewEntryPath(session)
  if (!path) return ''
  const relative = workspaceRelativePath(path)
  const version = String(session?.result?.livePreviewVersion || session?.result?.livePreviewUpdatedAt || workspaceFileVersion(session))
  const params = new URLSearchParams({ v: version })
  if (selectedModuleId) params.set('module', selectedModuleId)
  return `${basePath}/files/${relative.split('/').map(encodeURIComponent).join('/')}?${params.toString()}`
}

export function hasPrimaryResults(session?: Session | null) {
  const result = session?.result
  const renderPngPath = result?.renderPngPath || getSessionRenderPngPath(session)
  return Boolean(
    result &&
      result.finalOutputReady !== false &&
      ((result.svgPngPath && renderPngPath) || result.localArtifactCacheStatus === 'cached'),
  )
}
