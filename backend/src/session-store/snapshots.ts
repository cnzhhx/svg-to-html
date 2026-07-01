import path from 'node:path'
import { mkdir, readdir, readFile } from 'node:fs/promises'

import {
  isOutputFormat,
  type OutputFormat,
  type SessionOutputTarget,
} from '../core/output-target.js'
import { isRecord } from '../core/type-guards.js'
import { createSessionPaths, getSessionsRoot } from './paths.js'
import { ensureWorkflowProgress } from './progress.js'
import type { Session, SessionResult } from './types.js'

type JsonRecord = Record<string, unknown>

const optionalString = (value: unknown) =>
  typeof value === 'string' ? value : undefined

const optionalPositiveNumber = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

const sanitizeOutputTarget = (
  value: unknown,
  outputFormat: OutputFormat,
): SessionOutputTarget | null => {
  if (!isRecord(value)) return null
  if (value.format !== outputFormat) return null
  const sourceEntryPath = optionalString(value.sourceEntryPath)
  const renderEntryPath = optionalString(value.renderEntryPath)
  const compareEntryPath = optionalString(value.compareEntryPath)
  if (!sourceEntryPath || !renderEntryPath || !compareEntryPath) return null
  return {
    compareEntryPath,
    format: outputFormat,
    frameworkBuildDir: optionalString(value.frameworkBuildDir),
    renderEntryPath,
    sourceEntryPath,
    sourceStylePath: optionalString(value.sourceStylePath),
  }
}

const RESULT_KEYS = new Set<keyof SessionResult>([
  'sourceEntryPath',
  'sourceStylePath',
  'renderEntryPath',
  'compareEntryPath',
  'outputTarget',
  'designWidth',
  'designHeight',
  'containerLayoutPath',
  'diffRatio',
  'svgPngPath',
  'renderPngPath',
  'artifactDir',
  'sourceBasis',
  'sourceRenderMode',
  'tokensUsed',
  'cachedInputTokens',
  'inputTokens',
  'uncachedInputTokens',
  'outputTokens',
  'verifyMode',
  'moduleAgentManifestPath',
  'moduleActiveIds',
  'moduleAgentRuns',
  'moduleAgentThreadIds',
  'moduleValidationRuns',
  'modelTelemetryRecords',
  'modelUsageRecords',
  'moduleConcurrencyLimit',
  'moduleCount',
  'moduleCountExceedsConcurrency',
  'moduleDiffRegionsPath',
  'moduleFailedIds',
  'moduleFailureKinds',
  'moduleFailures',
  'modulePlanMode',
  'moduleManifestPath',
  'moduleMergeManifestPath',
  'modulePlanMarkdownPath',
  'modulePlanPath',
  'modulePlanQualityMarkdownPath',
  'modulePlanQualityPath',
  'regionsPath',
  'agentResponse',
  'workflowHistoryDir',
  'workflowHistoryManifestPath',
  'workflowArchives',
  'multiAgentRoute',
  'multiAgentRouteReason',
  'textTuningAppliedCount',
  'textTuningReportPath',
])

const sanitizeResult = (
  value: unknown,
  outputTarget: SessionOutputTarget,
): SessionResult => {
  const result: SessionResult = {}
  if (isRecord(value)) {
    for (const [key, childValue] of Object.entries(value)) {
      if (RESULT_KEYS.has(key as keyof SessionResult)) {
        ;(result as Record<string, unknown>)[key] = childValue
      }
    }
  }
  result.compareEntryPath = outputTarget.compareEntryPath
  result.outputTarget = outputTarget
  result.renderEntryPath = outputTarget.renderEntryPath
  result.sourceEntryPath = outputTarget.sourceEntryPath
  result.sourceStylePath = outputTarget.sourceStylePath
  return result
}

const TOP_LEVEL_KEYS = new Set<keyof Session>([
  'id',
  'designName',
  'queuedAt',
  'executionStartedAt',
  'threadId',
  'svgPath',
  'scale',
  'sessionDir',
  'artifactDir',
  'outputFormat',
  'outputTarget',
  'status',
  'activeStep',
  'steps',
  'result',
  'error',
  'logs',
  'messages',
  'pendingUserMessages',
  'progress',
  'persistence',
  'createdAt',
  'updatedAt',
])

const sanitizeCurrentSessionSnapshot = (value: unknown): Session | null => {
  if (!isRecord(value)) return null
  if (!isOutputFormat(value.outputFormat)) return null
  const outputFormat = value.outputFormat
  const outputTarget = sanitizeOutputTarget(value.outputTarget, outputFormat)
  if (!outputTarget) return null
  const session: JsonRecord = {}
  for (const [key, childValue] of Object.entries(value)) {
    if (TOP_LEVEL_KEYS.has(key as keyof Session)) session[key] = childValue
  }
  session.outputFormat = outputFormat
  session.outputTarget = outputTarget
  session.result = sanitizeResult(value.result, outputTarget)
  return session as Session
}

const inferExecutionStartedAtFromEvents = async (
  eventsPath: string,
): Promise<number | undefined> => {
  let raw: string
  try {
    raw = await readFile(eventsPath, 'utf8')
  } catch {
    return undefined
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as unknown
      if (!isRecord(event)) continue
      const data = event.data
      if (
        event.type === 'session:updated' &&
        isRecord(data) &&
        data.status === 'running'
      ) {
        return optionalPositiveNumber(event.timestamp)
      }
    } catch {
      // Ignore malformed historical event records.
    }
  }
  return undefined
}

const loadSessionSnapshots = async (): Promise<Session[]> => {
  const root = getSessionsRoot()
  await mkdir(root, { recursive: true })
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sessions: Session[] = []

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const { eventsPath, snapshotPath } = createSessionPaths(
      path.join(root, entry.name),
    )
    try {
      const raw = await readFile(snapshotPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const session = sanitizeCurrentSessionSnapshot(parsed)
      if (!session) continue
      session.executionStartedAt =
        session.status === 'queued' || session.status === 'draft'
          ? undefined
          : optionalPositiveNumber(session.executionStartedAt) ??
            await inferExecutionStartedAtFromEvents(eventsPath)
      ensureWorkflowProgress(session)
      sessions.push(session)
    } catch {
      // Ignore broken session snapshots and keep booting.
    }
  }

  return sessions
}

export { loadSessionSnapshots }
