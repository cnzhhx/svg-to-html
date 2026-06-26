import { truncate } from '../../../core/string-utils.js'
import { ARCHIVE_COMMAND_OUTPUT_MAX_CHARS } from '../../../config/index.js'
import { sessionStore } from '../../../session-store.js'
import type { WorkflowArchiveMaterial } from '../../workflow-archive.js'
import { archiveSessionCheckpoint } from '../archive/checkpoint.js'

import type { AgentCommandKind } from './agent-turn-types.js'

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeCommandPathSeparators = (value: string) =>
  value.replaceAll('\\', '/')

const PNPM_DIR_OPTION_PATTERN =
  String.raw`(?:\s+(?:(?:--dir|-C)\s+["']?[^"'\s;&|]+["']?))*`

const commandRunsCli = (command: string, cliPath: string) => {
  const normalizedCommand = normalizeCommandPathSeparators(command)
  const escapedPath = escapeRegExp(
    normalizeCommandPathSeparators(cliPath.replace(/^\.\//, '')),
  )
  const pattern = new RegExp(
    `(?:^|[\\s;&|])(?:pnpm${PNPM_DIR_OPTION_PATTERN}\\s+exec\\s+tsx|tsx)\\s+["']?(?:\\./|[^\\s"']*/)?${escapedPath}["']?(?:\\s|$)`,
  )
  return pattern.test(normalizedCommand)
}

const commandRunsPackageScript = (command: string, scriptName: string) => {
  const escapedScriptName = escapeRegExp(scriptName)
  const pattern = new RegExp(
    `(?:^|[\\s;&|])pnpm${PNPM_DIR_OPTION_PATTERN}\\s+(?:run\\s+)?${escapedScriptName}(?:\\s|$)`,
  )
  return pattern.test(command)
}

const classifyAgentWorkflowCommand = (command: string): AgentCommandKind | null => {
  if (
    commandRunsCli(command, 'src/cli/verify-design.ts') ||
    commandRunsPackageScript(command, 'task:verify')
  ) {
    return 'verify-design'
  }
  if (
    commandRunsCli(command, 'src/cli/verify-module-design.ts') ||
    commandRunsPackageScript(command, 'task:verify-module')
  ) {
    return 'verify-module-design'
  }
  if (
    commandRunsCli(command, 'src/cli/verify-module-framework.ts') ||
    commandRunsPackageScript(command, 'task:verify-module-framework')
  ) {
    return 'verify-module-framework'
  }
  return null
}

const parseVerifyDiffRatio = (output: string) => {
  // Modern verify CLIs emit compact JSON such as {"diffRatio":0.0914,"passed":false}
  try {
    const parsedJson = JSON.parse(output) as unknown
    if (
      typeof parsedJson === 'object' &&
      parsedJson !== null &&
      'diffRatio' in parsedJson &&
      typeof (parsedJson as { diffRatio: unknown }).diffRatio === 'number'
    ) {
      const parsed = (parsedJson as { diffRatio: number }).diffRatio
      return Number.isFinite(parsed) ? parsed : undefined
    }
  } catch {
    // fall through to legacy text format
  }

  const match = output.match(/Diff ratio:\s*([0-9.]+)/i)
  const jsonLikeMatch =
    match ?? output.match(/"diffRatio"\s*:\s*([0-9.]+(?:e[+-]?\d+)?)/i)
  if (!jsonLikeMatch) return undefined
  const parsed = Number(jsonLikeMatch[1])
  return Number.isFinite(parsed) ? parsed : undefined
}


const getAgentCommandStatus = ({
  exitCode,
}: {
  exitCode: number | null
}): 'completed' | 'failed' => {
  if (exitCode !== 0) return 'failed'
  return 'completed'
}

const truncateArchiveOutput = (output: string): string => {
  if (ARCHIVE_COMMAND_OUTPUT_MAX_CHARS <= 0) return output
  return truncate(
    output,
    ARCHIVE_COMMAND_OUTPUT_MAX_CHARS,
    (value) => `\n\n[truncated: ${value.length} chars total]`,
  )
}

const buildAgentCommandArchiveMaterials = ({
  output,
  renderEntryPath,
}: {
  output: string
  renderEntryPath: string
}): WorkflowArchiveMaterial[] => {
  const materials: WorkflowArchiveMaterial[] = [
    {
      kind: 'text',
      label: 'Command Output',
      targetName: 'command-output.log',
      content: truncateArchiveOutput(output) || '(empty)',
    },
    {
      kind: 'file',
      label: 'Render Entry Snapshot',
      sourcePath: renderEntryPath,
      optional: true,
    },
  ]

  return materials
}

const archiveAgentCommandCheckpoint = async ({
  command,
  commandKind,
  exitCode,
  internalRound,
  output,
  round,
  sessionId,
}: {
  command: string
  commandKind: AgentCommandKind
  exitCode?: number | null
  internalRound: number
  output: string
  round: number
  sessionId: string
}) => {
  const session = sessionStore.get(sessionId)
  if (!session) return

  const diffRatio =
    commandKind === 'verify-design' ||
    commandKind === 'verify-module-design' ||
    commandKind === 'verify-module-framework'
      ? parseVerifyDiffRatio(output)
      : undefined
  const normalizedExitCode = typeof exitCode === 'number' ? exitCode : null
  const status = getAgentCommandStatus({
    exitCode: normalizedExitCode,
  })
  const note =
    status === 'completed'
      ? `Agent workflow command completed: ${commandKind}`
      : `Agent workflow command failed: ${commandKind}`

  await archiveSessionCheckpoint({
    sessionId,
    round,
    stage: 'agent-command',
    diffRatio,
    note,
    metadata: {
      command,
      commandKind,
      exitCode: normalizedExitCode,
      internalRound,

      source: 'model-agent-turn',
    },
    materials: buildAgentCommandArchiveMaterials({
      output,
      renderEntryPath: session.outputTarget.renderEntryPath,
    }),
  })
}

export {
  archiveAgentCommandCheckpoint,
  classifyAgentWorkflowCommand,
  getAgentCommandStatus,
  parseVerifyDiffRatio,
}
