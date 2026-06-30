import type { OutputFormat, Session, SessionOutputTarget } from '../types/session'
import { deleteLocalArtifactCache } from './artifact-cache'
import { getOutputTarget, getSessionOutputFormat, normalizeFsPath } from './artifacts'
import { STORAGE_KEYS, readJsonStorage, readStringStorage, writeJsonStorage, writeStringStorage } from './storage'

const LOCAL_SESSION_MESSAGE_LIMIT = 80
const LOCAL_SESSION_EVENT_TEXT_LIMIT = 100
const LOCAL_SESSION_REASONING_TEXT_LIMIT = 4000
const VALID_OUTPUT_FORMATS = new Set(['html', 'vue', 'react'])
const ARTIFACT_RESULT_KEYS = [
  'localArtifactCacheStatus',
  'localArtifactCacheFileCount',
  'localArtifactCacheByteSize',
  'localArtifactCachePaths',
  'localArtifactCacheAt',
  'localArtifactCacheError',
]

let localClientId: string | null = null
let localSessionStorageEnabled = false

export function setLocalSessionStorageEnabled(enabled: boolean) {
  localSessionStorageEnabled = enabled
}

export function createLocalClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  const random = new Uint8Array(16)
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(random)
    return Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('')
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getLocalClientId() {
  if (localClientId) return localClientId
  const stored = readStringStorage(STORAGE_KEYS.clientId, '').trim()
  if (stored) {
    localClientId = stored
    return localClientId
  }
  localClientId = createLocalClientId()
  writeStringStorage(STORAGE_KEYS.clientId, localClientId)
  return localClientId
}

export function isSessionOwnedByCurrentClient(session?: Session | null) {
  return Boolean(session?.localOwnerId && session.localOwnerId === getLocalClientId())
}

export function getLocalSessionIds() {
  return readJsonStorage<string[]>(STORAGE_KEYS.sessions, []).filter(Boolean).map(String)
}

export function saveLocalSessionId(id: string) {
  if (!localSessionStorageEnabled || !id) return
  const ids = getLocalSessionIds().filter((item) => item !== id)
  ids.unshift(id)
  writeJsonStorage(STORAGE_KEYS.sessions, ids)
}

export function markSessionOwnedByCurrentClient(id: string) {
  if (!localSessionStorageEnabled || !id) return null
  saveLocalSessionId(id)
  return getLocalClientId()
}

export function removeLocalSessionId(id: string) {
  writeJsonStorage(STORAGE_KEYS.sessions, getLocalSessionIds().filter((item) => item !== id))
  const snapshots = readLocalSessionSnapshots()
  delete snapshots[id]
  writeJsonStorage(STORAGE_KEYS.localSessionSnapshots, snapshots)
  void deleteLocalArtifactCache(id).catch(() => {})
}

export function readLocalSessionSnapshots() {
  const values = readJsonStorage<Record<string, Session & { localSavedAt?: number }>>(STORAGE_KEYS.localSessionSnapshots, {})
  return Object.fromEntries(
    Object.entries(values).flatMap(([, snapshot]) => {
      const sanitized = sanitizeLocalSessionSnapshot(snapshot)
      return sanitized?.localOwnerId === getLocalClientId() ? [[sanitized.id, sanitized]] : []
    }),
  )
}

export function getLocalSessionSnapshot(id: string) {
  return readLocalSessionSnapshots()[id] || null
}

export function getLocalSessionSnapshotIds() {
  return Object.values(readLocalSessionSnapshots())
    .sort((left, right) => Number((right as { localSavedAt?: number }).localSavedAt || right.updatedAt || 0) - Number((left as { localSavedAt?: number }).localSavedAt || left.updatedAt || 0))
    .map((snapshot) => snapshot.id)
}

export function canPersistSessionLocally(session?: Session | null) {
  if (!localSessionStorageEnabled || !session?.id) return false
  return isSessionOwnedByCurrentClient(session) || Boolean(getLocalSessionSnapshot(session.id)?.localOwnerId === getLocalClientId())
}

export function saveServerSessionsToLocal(serverSessions: Session[]) {
  if (!localSessionStorageEnabled) return
  const own = serverSessions.filter((session) => canPersistSessionLocally(session))
  if (!own.length) return
  const serverIds = own.map((session) => session.id)
  const serverIdSet = new Set(serverIds)
  const nextIds = unique([...serverIds, ...getLocalSessionIds().filter((id) => !serverIdSet.has(id)), ...getLocalSessionSnapshotIds().filter((id) => !serverIdSet.has(id))])
  writeJsonStorage(STORAGE_KEYS.sessions, nextIds)
  const snapshots = readLocalSessionSnapshots()
  own.forEach((session) => {
    const snapshot = createLocalSessionSnapshot(session)
    if (snapshot) snapshots[snapshot.id] = snapshot
  })
  writeJsonStorage(STORAGE_KEYS.localSessionSnapshots, snapshots)
}

export function reviveLocalSessionSnapshot(snapshot: unknown, reason = 'server-reset'): Session | null {
  const sanitized = sanitizeLocalSessionSnapshot(snapshot)
  if (!sanitized?.id) return null
  const stable = new Set(['draft', 'completed', 'best-effort', 'failed-gate', 'failed'])
  const staleExecution = !stable.has(String(sanitized.status || ''))
  const staleReason = reason === 'server-reset' ? '云端实例已重置，仅保留本地快照' : '执行已中断，仅保留本地快照'
  return {
    ...sanitized,
    __localOnly: true,
    activeStep: staleExecution ? null : sanitized.activeStep || null,
    error: staleExecution ? staleReason : sanitized.error,
    logs: [],
    messages: Array.isArray(sanitized.messages) ? sanitized.messages : [],
    pendingUserMessages: [],
    progress: staleExecution
      ? {
          currentNode: sanitized.progress?.currentNode || null,
          detail: staleReason,
          iteration: sanitized.progress?.iteration || 0,
          maxIterations: sanitized.progress?.maxIterations,
          nodes: sanitized.progress?.nodes || {
            upload: { label: '已上传', status: 'completed' },
            analysis: { label: '结构解析', status: 'failed' },
            agent: { label: '大模型生成', status: 'pending' },
            verify: { label: '视觉校验', status: 'pending' },
            done: { label: '完成', status: 'pending' },
          },
        }
      : sanitized.progress,
    status: staleExecution ? 'failed' : sanitized.status,
  }
}

export function saveLocalSessionSnapshot(session: Session, options: { touch?: boolean } = {}) {
  if (!canPersistSessionLocally(session)) return
  const snapshot = createLocalSessionSnapshot(session)
  if (!snapshot) return
  if (options.touch !== false) saveLocalSessionId(snapshot.id)
  const snapshots = readLocalSessionSnapshots()
  if (snapshots[snapshot.id]?.result) {
    snapshot.result = mergeLocalArtifactResult(snapshots[snapshot.id].result, snapshot.result)
  }
  snapshots[snapshot.id] = snapshot
  writeJsonStorage(STORAGE_KEYS.localSessionSnapshots, snapshots)
}

function createLocalSessionSnapshot(session: Session) {
  const outputFormat = getSessionOutputFormat(session) as OutputFormat
  const outputTarget = getOutputTarget(session)
  if (!outputFormat || !outputTarget) return null
  const result = compactResultForLocalStorage(session.result)
  return {
    ...session,
    activeStep: session.activeStep || null,
    artifactDir: String(session.artifactDir || result.artifactDir || ''),
    createdAt: Number(session.createdAt) || Date.now(),
    error: truncateForLocalStorage(session.error, LOCAL_SESSION_EVENT_TEXT_LIMIT) || undefined,
    localOwnerId: getLocalClientId(),
    localSavedAt: Date.now(),
    logs: [],
    messages: compactMessagesForLocalStorage(session.messages),
    outputFormat,
    outputTarget,
    pendingUserMessages: [],
    result: {
      ...result,
      compareEntryPath: outputTarget.compareEntryPath,
      outputTarget,
      renderEntryPath: outputTarget.renderEntryPath,
      sourceEntryPath: outputTarget.sourceEntryPath,
      ...(outputTarget.sourceStylePath ? { sourceStylePath: outputTarget.sourceStylePath } : {}),
    },
    scale: Number(session.scale || 1),
    updatedAt: Number(session.updatedAt) || Date.now(),
  } as unknown as Session & { localSavedAt: number }
}

function sanitizeLocalSessionSnapshot(snapshot: unknown): (Session & { localSavedAt?: number }) | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const value = snapshot as Session & { localSavedAt?: number }
  const outputFormat = String(value.outputFormat || '').trim().toLowerCase() as OutputFormat
  const outputTarget = sanitizeLocalOutputTarget(value.outputTarget, outputFormat)
  const id = String(value.id || '').trim()
  if (!id || !outputTarget) return null
  return {
    ...value,
    activeStep: value.activeStep || null,
    artifactDir: String(value.artifactDir || value.result?.artifactDir || ''),
    createdAt: Number(value.createdAt) || Date.now(),
    designName: String(value.designName || id),
    error: value.error ? truncateForLocalStorage(value.error, LOCAL_SESSION_EVENT_TEXT_LIMIT) : undefined,
    id,
    localOwnerId: String(value.localOwnerId || ''),
    localSavedAt: Number(value.localSavedAt || value.updatedAt || Date.now()),
    logs: [],
    messages: compactMessagesForLocalStorage(value.messages),
    outputFormat,
    outputTarget,
    pendingUserMessages: [],
    result: sanitizeLocalResult(value.result, outputTarget),
    scale: Number(value.scale || 1),
    sessionDir: String(value.sessionDir || ''),
    status: value.status || 'completed',
    steps: value.steps || { agent: { status: 'pending' }, verify: { status: 'pending' } },
    svgPath: String(value.svgPath || ''),
    updatedAt: Number(value.updatedAt) || Date.now(),
  }
}

function sanitizeLocalOutputTarget(value: unknown, outputFormat: OutputFormat): SessionOutputTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as SessionOutputTarget
  if (!VALID_OUTPUT_FORMATS.has(outputFormat) || target.format !== outputFormat) return null
  if (!target.sourceEntryPath || !target.renderEntryPath || !target.compareEntryPath) return null
  return {
    compareEntryPath: String(target.compareEntryPath),
    format: outputFormat,
    ...(target.frameworkBuildDir ? { frameworkBuildDir: String(target.frameworkBuildDir) } : {}),
    renderEntryPath: String(target.renderEntryPath),
    sourceEntryPath: String(target.sourceEntryPath),
    ...(target.sourceStylePath ? { sourceStylePath: String(target.sourceStylePath) } : {}),
  }
}

function sanitizeLocalResult(result: unknown, outputTarget: SessionOutputTarget) {
  return {
    ...compactResultForLocalStorage(result),
    compareEntryPath: outputTarget.compareEntryPath,
    outputTarget,
    renderEntryPath: outputTarget.renderEntryPath,
    sourceEntryPath: outputTarget.sourceEntryPath,
    ...(outputTarget.sourceStylePath ? { sourceStylePath: outputTarget.sourceStylePath } : {}),
  }
}

function compactResultForLocalStorage(result: unknown) {
  if (!result || typeof result !== 'object') return {}
  const source = result as Record<string, unknown>
  const keys = [
    'artifactDir',
    'compareEntryPath',
    'designWidth',
    'designHeight',
    'diffPngPath',
    'diffRatio',
    'finalOutputReady',
    'cachedInputTokens',
    'inputTokens',
    'moduleAgentRuns',
    'moduleAgentThreadIds',
    'moduleConcurrencyLimit',
    'moduleCount',
    'moduleFailedIds',
    'moduleFailures',
    'modulePlanPath',
    'outputTarget',
    'outputTokens',
    'renderEntryPath',
    'renderPngPath',
    'sourceEntryPath',
    'sourceStylePath',
    'svgPngPath',
    'tokensUsed',
    'uncachedInputTokens',
    'verifyMode',
    ...ARTIFACT_RESULT_KEYS,
  ]
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]))
}

function compactMessagesForLocalStorage(messages?: Session['messages']) {
  if (!Array.isArray(messages)) return []
  return messages.filter(Boolean).slice(-LOCAL_SESSION_MESSAGE_LIMIT).map((message) => ({
    agentEventType: message.agentEventType,
    agentItemType: message.agentItemType,
    createdAt: Number(message.createdAt) || Date.now(),
    id: String(message.id || `local-${Date.now()}`),
    kind: message.kind || 'chat',
    moduleId: message.moduleId,
    role: message.role || 'assistant',
    sourceLabel: message.sourceLabel,
    text: truncateForLocalStorage(message.text, message.agentItemType === 'reasoning' ? LOCAL_SESSION_REASONING_TEXT_LIMIT : message.kind === 'event' ? LOCAL_SESSION_EVENT_TEXT_LIMIT : Number.POSITIVE_INFINITY),
  }))
}

function mergeLocalArtifactResult(sourceResult: Session['result'], targetResult: Session['result']) {
  const next = { ...targetResult }
  ARTIFACT_RESULT_KEYS.forEach((key) => {
    if (sourceResult?.[key] !== undefined && next[key] === undefined) next[key] = sourceResult[key]
  })
  return next
}

function truncateForLocalStorage(value: unknown, limit = Number.POSITIVE_INFINITY) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function unique(ids: string[]) {
  return [...new Set(ids.filter(Boolean).map(String))]
}

export function cachedRootArtifactPath(session: Session | null | undefined, fileName: string) {
  const paths = Array.isArray(session?.result?.localArtifactCachePaths) ? session.result.localArtifactCachePaths.map(normalizeFsPath) : []
  if (!paths.length) return ''
  const pathSet = new Set(paths)
  const artifactDir = normalizeFsPath(session?.artifactDir || session?.result?.artifactDir || '')
  const sessionDir = normalizeFsPath(session?.sessionDir || '')
  const candidates = [
    artifactDir ? `${artifactDir}/${fileName}` : '',
    sessionDir ? `${sessionDir}/artifacts/${fileName}` : '',
  ].filter(Boolean)
  return candidates.find((candidate) => pathSet.has(candidate)) || paths.find((item) => item.endsWith(`/artifacts/${fileName}`) && !item.includes('/modules/')) || ''
}
