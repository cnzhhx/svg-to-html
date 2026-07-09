import type { OutputFormat, Job, JobOutputTarget } from '../types/job'
import { deleteLocalArtifactCache } from './artifact-cache'
import { getOutputTarget, getJobOutputFormat, normalizeFsPath } from './artifacts'
import { STORAGE_KEYS, readJsonStorage, readStringStorage, writeJsonStorage, writeStringStorage } from './storage'

const LOCAL_JOB_MESSAGE_LIMIT = 80
const LOCAL_JOB_EVENT_TEXT_LIMIT = 100
const LOCAL_JOB_REASONING_TEXT_LIMIT = 4000
const VALID_OUTPUT_FORMATS = new Set(['html', 'vue', 'react'])
const ARTIFACT_RESULT_KEYS = [
  'localArtifactCacheStatus',
  'localArtifactCacheFileCount',
  'localArtifactCacheByteSize',
  'localArtifactCachePaths',
  'localArtifactCacheAt',
  'localArtifactCacheError',
  'localArtifactCacheKey',
]

let localClientId: string | null = null
let localJobStorageEnabled = false

export function setLocalJobStorageEnabled(enabled: boolean) {
  localJobStorageEnabled = enabled
}

function createLocalClientId() {
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

export function isJobOwnedByCurrentClient(job?: Job | null) {
  return Boolean(job?.localOwnerId && job.localOwnerId === getLocalClientId())
}

export function getLocalJobIds() {
  return readJsonStorage<string[]>(STORAGE_KEYS.jobs, []).filter(Boolean).map(String)
}

function saveLocalJobId(id: string) {
  if (!localJobStorageEnabled || !id) return
  const ids = getLocalJobIds().filter((item) => item !== id)
  ids.unshift(id)
  writeJsonStorage(STORAGE_KEYS.jobs, ids)
}

export function markJobOwnedByCurrentClient(id: string) {
  if (!localJobStorageEnabled || !id) return null
  saveLocalJobId(id)
  return getLocalClientId()
}

export function removeLocalJobId(id: string) {
  writeJsonStorage(STORAGE_KEYS.jobs, getLocalJobIds().filter((item) => item !== id))
  const snapshots = readLocalJobSnapshots()
  delete snapshots[id]
  writeJsonStorage(STORAGE_KEYS.localJobSnapshots, snapshots)
  void deleteLocalArtifactCache(id).catch(() => {})
}

function readLocalJobSnapshots() {
  const values = readJsonStorage<Record<string, Job & { localSavedAt?: number }>>(STORAGE_KEYS.localJobSnapshots, {})
  return Object.fromEntries(
    Object.entries(values).flatMap(([, snapshot]) => {
      const sanitized = sanitizeLocalJobSnapshot(snapshot)
      return sanitized?.localOwnerId === getLocalClientId() ? [[sanitized.id, sanitized]] : []
    }),
  )
}

export function getLocalJobSnapshot(id: string) {
  return readLocalJobSnapshots()[id] || null
}

function getLocalJobSnapshotIds() {
  return Object.values(readLocalJobSnapshots())
    .sort((left, right) => Number((right as { localSavedAt?: number }).localSavedAt || right.updatedAt || 0) - Number((left as { localSavedAt?: number }).localSavedAt || left.updatedAt || 0))
    .map((snapshot) => snapshot.id)
}

function canPersistJobLocally(job?: Job | null) {
  if (!localJobStorageEnabled || !job?.id) return false
  return isJobOwnedByCurrentClient(job) || Boolean(getLocalJobSnapshot(job.id)?.localOwnerId === getLocalClientId())
}

export function saveServerJobsToLocal(serverJobs: Job[]) {
  if (!localJobStorageEnabled) return
  const own = serverJobs.filter((job) => canPersistJobLocally(job))
  if (!own.length) return
  const serverIds = own.map((job) => job.id)
  const serverIdSet = new Set(serverIds)
  const nextIds = unique([...serverIds, ...getLocalJobIds().filter((id) => !serverIdSet.has(id)), ...getLocalJobSnapshotIds().filter((id) => !serverIdSet.has(id))])
  writeJsonStorage(STORAGE_KEYS.jobs, nextIds)
  const snapshots = readLocalJobSnapshots()
  own.forEach((job) => {
    const snapshot = createLocalJobSnapshot(job)
    if (snapshot) snapshots[snapshot.id] = snapshot
  })
  writeJsonStorage(STORAGE_KEYS.localJobSnapshots, snapshots)
}

export function reviveLocalJobSnapshot(snapshot: unknown, reason = 'server-reset'): Job | null {
  const sanitized = sanitizeLocalJobSnapshot(snapshot)
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

export function saveLocalJobSnapshot(job: Job, options: { touch?: boolean } = {}) {
  if (!canPersistJobLocally(job)) return
  const snapshot = createLocalJobSnapshot(job)
  if (!snapshot) return
  if (options.touch !== false) saveLocalJobId(snapshot.id)
  const snapshots = readLocalJobSnapshots()
  if (snapshots[snapshot.id]?.result) {
    snapshot.result = mergeLocalArtifactResult(snapshots[snapshot.id].result, snapshot.result)
  }
  snapshots[snapshot.id] = snapshot
  writeJsonStorage(STORAGE_KEYS.localJobSnapshots, snapshots)
}

function createLocalJobSnapshot(job: Job) {
  const outputFormat = getJobOutputFormat(job) as OutputFormat
  const outputTarget = getOutputTarget(job)
  if (!outputFormat || !outputTarget) return null
  const result = compactResultForLocalStorage(job.result)
  return {
    ...job,
    activeStep: job.activeStep || null,
    artifactDir: String(job.artifactDir || result.artifactDir || ''),
    createdAt: Number(job.createdAt) || Date.now(),
    error: truncateForLocalStorage(job.error, LOCAL_JOB_EVENT_TEXT_LIMIT) || undefined,
    localOwnerId: getLocalClientId(),
    localSavedAt: Date.now(),
    logs: [],
    messages: compactMessagesForLocalStorage(job.messages),
    model: job.model ? String(job.model) : undefined,
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
    scale: Number(job.scale || 1),
    updatedAt: Number(job.updatedAt) || Date.now(),
  } as unknown as Job & { localSavedAt: number }
}

function sanitizeLocalJobSnapshot(snapshot: unknown): (Job & { localSavedAt?: number }) | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const value = snapshot as Job & { localSavedAt?: number }
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
    error: value.error ? truncateForLocalStorage(value.error, LOCAL_JOB_EVENT_TEXT_LIMIT) : undefined,
    id,
    localOwnerId: String(value.localOwnerId || ''),
    localSavedAt: Number(value.localSavedAt || value.updatedAt || Date.now()),
    logs: [],
    messages: compactMessagesForLocalStorage(value.messages),
    model: value.model ? String(value.model) : undefined,
    outputFormat,
    outputTarget,
    pendingUserMessages: [],
    result: sanitizeLocalResult(value.result, outputTarget),
    scale: Number(value.scale || 1),
    jobDir: String(value.jobDir || ''),
    status: value.status || 'completed',
    steps: value.steps || { agent: { status: 'pending' }, verify: { status: 'pending' } },
    svgPath: String(value.svgPath || ''),
    updatedAt: Number(value.updatedAt) || Date.now(),
  }
}

function sanitizeLocalOutputTarget(value: unknown, outputFormat: OutputFormat): JobOutputTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as JobOutputTarget
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

function sanitizeLocalResult(result: unknown, outputTarget: JobOutputTarget) {
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
    'artifactUpdatedAt',
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

function compactMessagesForLocalStorage(messages?: Job['messages']) {
  if (!Array.isArray(messages)) return []
  return messages.filter(Boolean).slice(-LOCAL_JOB_MESSAGE_LIMIT).map((message) => ({
    agentEventType: message.agentEventType,
    agentItemType: message.agentItemType,
    createdAt: Number(message.createdAt) || Date.now(),
    id: String(message.id || `local-${Date.now()}`),
    kind: message.kind || 'chat',
    moduleId: message.moduleId,
    role: message.role || 'assistant',
    sourceLabel: message.sourceLabel,
    text: truncateForLocalStorage(message.text, message.agentItemType === 'reasoning' ? LOCAL_JOB_REASONING_TEXT_LIMIT : message.kind === 'event' ? LOCAL_JOB_EVENT_TEXT_LIMIT : Number.POSITIVE_INFINITY),
  }))
}

function mergeLocalArtifactResult(sourceResult: Job['result'], targetResult: Job['result']) {
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

export function cachedRootArtifactPath(job: Job | null | undefined, fileName: string) {
  const paths = Array.isArray(job?.result?.localArtifactCachePaths) ? job.result.localArtifactCachePaths.map(normalizeFsPath) : []
  if (!paths.length) return ''
  const pathSet = new Set(paths)
  const artifactDir = normalizeFsPath(job?.artifactDir || job?.result?.artifactDir || '')
  const jobDir = normalizeFsPath(job?.jobDir || '')
  const candidates = [
    artifactDir ? `${artifactDir}/${fileName}` : '',
    jobDir ? `${jobDir}/artifacts/${fileName}` : '',
  ].filter(Boolean)
  return candidates.find((candidate) => pathSet.has(candidate)) || paths.find((item) => item.endsWith(`/artifacts/${fileName}`) && !item.includes('/modules/')) || ''
}
