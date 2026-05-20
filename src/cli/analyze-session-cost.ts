import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  getWorkspaceRoot,
  writeJsonFile,
  writeTextFile,
} from '../core/utils.js'

type JsonRecord = Record<string, unknown>

const VALUE_FLAGS = new Set(['--output-dir'])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const asNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const asArray = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

const asUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : []

const readJsonIfExists = async <T = unknown>(filePath: string) => {
  if (!existsSync(filePath)) return null
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

const parseArgs = (args: string[]) => {
  const paths: string[] = []
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    const inline = [...VALUE_FLAGS].find((flag) => arg.startsWith(`${flag}=`))
    if (inline) {
      values.set(inline, arg.slice(inline.length + 1))
      continue
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${arg}`)
      values.set(arg, value)
      index += 1
      continue
    }
    paths.push(arg)
  }
  return { outputDir: values.get('--output-dir'), paths }
}

const resolveSessionDir = (input: string) => {
  const direct = path.resolve(input)
  if (existsSync(path.join(direct, 'session.json'))) return direct

  const byId = path.join(getWorkspaceRoot(), 'sessions', input)
  if (existsSync(path.join(byId, 'session.json'))) return byId

  throw new Error(`Unable to locate session.json for ${input}`)
}

const discoverSessionDirs = async () => {
  const sessionsRoot = path.join(getWorkspaceRoot(), 'sessions')
  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(
    () => [],
  )
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsRoot, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'session.json')))
}

const formatSeconds = (ms: number | undefined) =>
  ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)}s`

const formatPercent = (value: number | undefined) =>
  value === undefined ? 'n/a' : `${(value * 100).toFixed(2)}%`

const sum = (values: Array<number | undefined>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0)

const getPath = (value: unknown, keys: string[]) => {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

const getDiffValue = (run: JsonRecord) => {
  const timeline = asArray(
    getPath(run, ['turnSummary', 'internalDiffTimeline']),
  )
  const lastTimelineDiff = asNumber(timeline.at(-1)?.diffRatio)
  return (
    lastTimelineDiff ??
    asNumber(run.finalDiffRatio) ??
    asNumber(run.feedbackInputDiffRatio)
  )
}

const getRunImprovement = (run: JsonRecord) => {
  const timeline = asArray(
    getPath(run, ['turnSummary', 'internalDiffTimeline']),
  )
  if (timeline.length >= 2) {
    const first = asNumber(timeline[0]?.diffRatio)
    const last = asNumber(timeline.at(-1)?.diffRatio)
    if (first !== undefined && last !== undefined) return first - last
  }
  const input = asNumber(run.feedbackInputDiffRatio)
  const output = getDiffValue(run)
  return input !== undefined && output !== undefined
    ? input - output
    : undefined
}

const readWorkflowArchives = async (
  session: JsonRecord,
  artifactDir: string,
) => {
  const fromSession = asArray(getPath(session, ['result', 'workflowArchives']))
  if (fromSession.length) return fromSession
  const history = await readJsonIfExists<JsonRecord>(
    path.join(artifactDir, 'workflow-history', 'manifest.json'),
  )
  return asArray(history?.entries)
}

const analyzeSession = async (sessionDir: string, outputDir?: string) => {
  const session = (await readJsonIfExists<JsonRecord>(
    path.join(sessionDir, 'session.json'),
  )) ?? { id: path.basename(sessionDir) }
  const artifactDir =
    (isString(session.artifactDir) ? session.artifactDir : undefined) ??
    path.join(sessionDir, 'artifacts')
  const moduleAgentManifest =
    (await readJsonIfExists<JsonRecord>(
      path.join(artifactDir, 'modules', 'module-agent-manifest.json'),
    )) ?? {}
  const verifyReport =
    (await readJsonIfExists<JsonRecord>(
      path.join(artifactDir, 'verify-report.json'),
    )) ?? {}
  const runs =
    asArray(moduleAgentManifest.runs).length > 0
      ? asArray(moduleAgentManifest.runs)
      : asArray(getPath(session, ['result', 'moduleAgentRuns']))
  const validationRuns =
    asArray(moduleAgentManifest.validationRuns).length > 0
      ? asArray(moduleAgentManifest.validationRuns)
      : asArray(getPath(session, ['result', 'moduleValidationRuns']))
  const workflowArchives = await readWorkflowArchives(session, artifactDir)
  const agentArchives = workflowArchives.filter(
    (entry) => entry.stage === 'agent',
  )
  const verifyArchives = workflowArchives.filter(
    (entry) => entry.stage === 'verify',
  )

  const moduleRuns = runs.map((run) => {
    const durationMs = asNumber(run.durationMs) ?? 0
    const improvement = getRunImprovement(run)
    return {
      allowedAssetCount: asNumber(run.allowedAssetCount),
      diffAfter: getDiffValue(run),
      durationMs,
      feedbackInputDiffRatio: asNumber(run.feedbackInputDiffRatio),
      id: String(run.id ?? 'unknown'),
      improvement,
      inputTokens: asNumber(run.inputTokens) ?? 0,
      outputTokens: asNumber(run.outputTokens) ?? 0,
      promptKind: String(run.promptKind ?? 'unknown'),
      round: asNumber(run.round) ?? 0,
      status: String(run.status ?? 'unknown'),
      totalCommands:
        asNumber(getPath(run, ['turnSummary', 'totalCommands'])) ?? 0,
      totalInternalRounds:
        asNumber(getPath(run, ['turnSummary', 'totalInternalRounds'])) ?? 0,
      totalShellCommands:
        asNumber(getPath(run, ['turnSummary', 'totalShellCommands'])) ?? 0,
      verifyCount: asNumber(getPath(run, ['turnSummary', 'verifyCount'])) ?? 0,
    }
  })

  const totalAgentDurationMs =
    sum(moduleRuns.map((run) => run.durationMs)) +
    sum(
      agentArchives.map((entry) =>
        asNumber(getPath(entry, ['metadata', 'durationMs'])),
      ),
    )
  const totalInputTokens = sum(moduleRuns.map((run) => run.inputTokens))
  const totalOutputTokens =
    sum(moduleRuns.map((run) => run.outputTokens)) +
    sum(
      agentArchives.map((entry) =>
        asNumber(getPath(entry, ['metadata', 'outputTokens'])),
      ),
    )
  const finalDiffRatio =
    asNumber(verifyReport.diffRatio) ??
    asNumber(getPath(session, ['result', 'diffRatio']))
  const validationSummary = validationRuns.map((run) => ({
    diffRatio: asNumber(run.diffRatio),
    modulesNeedingFeedback: asUnknownArray(run.modulesNeedingFeedback).map(
      String,
    ),
    round: asNumber(run.round),
    scope: String(run.scope ?? 'unknown'),
    threshold: asNumber(run.threshold),
  }))
  const bottlenecks = moduleRuns.flatMap((run) => {
    const issues: string[] = []
    if (run.durationMs >= 300_000) issues.push('long module turn >=300s')
    if (run.inputTokens >= 1_000_000) issues.push('very high input tokens')
    if (
      run.durationMs >= 120_000 &&
      run.improvement !== undefined &&
      run.improvement < 0.002
    ) {
      issues.push('low diff improvement for time spent')
    }
    return issues.length ? [{ ...run, issues }] : []
  })
  const report = {
    artifactDir,
    bottlenecks,
    final: {
      diffRatio: finalDiffRatio,
      finalOutputPolicyPassed: verifyReport.finalOutputPolicyPassed,
      layoutBoxPassed: verifyReport.layoutBoxPassed,
      moduleRegionDiffPassed: verifyReport.moduleRegionDiffPassed,
      textPriorityIssueCount: verifyReport.textPriorityIssueCount,
      workflowLintPassed: verifyReport.workflowLintPassed,
    },
    moduleRuns,
    session: {
      designName: session.designName,
      id: session.id ?? path.basename(sessionDir),
      status: session.status,
      updatedAt: session.updatedAt,
    },
    totals: {
      agentArchiveCount: agentArchives.length,
      moduleRunCount: moduleRuns.length,
      totalAgentDurationMs,
      totalInputTokens,
      totalOutputTokens,
      totalVerifyArchives: verifyArchives.length,
      totalVerifyCount: sum(moduleRuns.map((run) => run.verifyCount)),
    },
    validationRuns: validationSummary,
  }

  const targetDir = outputDir ? path.resolve(outputDir) : artifactDir
  const jsonPath = path.join(targetDir, 'session-cost-analysis.json')
  const markdownPath = path.join(targetDir, 'session-cost-analysis.md')
  await writeJsonFile(jsonPath, report)
  await writeTextFile(
    markdownPath,
    [
      `# Session Cost Analysis`,
      '',
      `- session: ${report.session.id}`,
      `- design: ${report.session.designName ?? 'n/a'}`,
      `- final diff: ${formatPercent(finalDiffRatio)}`,
      `- module runs: ${moduleRuns.length}`,
      `- total agent time: ${formatSeconds(totalAgentDurationMs)}`,
      `- total input tokens: ${totalInputTokens}`,
      `- total output tokens: ${totalOutputTokens}`,
      '',
      '## Module Runs',
      '',
      '| module | round | kind | time | input | output | verify | diff after | improvement | commands | assets |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...moduleRuns.map(
        (run) =>
          `| ${[
            run.id,
            run.round,
            run.promptKind,
            formatSeconds(run.durationMs),
            run.inputTokens,
            run.outputTokens,
            run.verifyCount,
            formatPercent(run.diffAfter),
            formatPercent(run.improvement),
            run.totalCommands,
            run.allowedAssetCount ?? 'n/a',
          ].join(' | ')} |`,
      ),
      '',
      '## Validation',
      '',
      '| round | scope | diff | threshold | feedback modules |',
      '| --- | --- | --- | --- | --- |',
      ...validationSummary.map(
        (run) =>
          `| ${run.round ?? 'n/a'} | ${run.scope} | ${formatPercent(run.diffRatio)} | ${formatPercent(run.threshold)} | ${run.modulesNeedingFeedback.join(', ') || '-'} |`,
      ),
      '',
      '## Bottlenecks',
      '',
      bottlenecks.length
        ? bottlenecks
            .map(
              (run) =>
                `- ${run.id} round ${run.round}: ${run.issues.join('; ')}; time=${formatSeconds(run.durationMs)}, input=${run.inputTokens}, improvement=${formatPercent(run.improvement)}`,
            )
            .join('\n')
        : '- none',
      '',
    ].join('\n'),
  )
  return { jsonPath, markdownPath, report }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const sessionDirs = args.paths.length
    ? args.paths.map(resolveSessionDir)
    : await discoverSessionDirs()
  if (!sessionDirs.length) {
    throw new Error(
      'No sessions found. Pass a session id or session directory.',
    )
  }
  const results = []
  for (const sessionDir of sessionDirs) {
    results.push(await analyzeSession(sessionDir, args.outputDir))
  }
  console.log(
    results
      .map(
        (result) =>
          `${result.report.session.id}: ${result.markdownPath} (${formatPercent(result.report.final.diffRatio)})`,
      )
      .join('\n'),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
