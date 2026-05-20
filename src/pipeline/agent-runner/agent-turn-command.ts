import path from 'node:path'

import { sessionStore } from '../../session-store.js'
import type { WorkflowArchiveMaterial } from '../workflow-archive.js'
import { archiveSessionCheckpoint } from './checkpoint.js'

import type {
  AgentCommandKind,
  AgentVerifyQualityStatus,
} from './agent-turn-types.js'

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
  return null
}

const parseVerifyDiffRatio = (output: string) => {
  const match = output.match(/Diff ratio:\s*([0-9.]+)/i)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseVerifyQualityStatus = (
  output: string,
): AgentVerifyQualityStatus | undefined => {
  const match = output.match(/"qualityStatus"\s*:\s*"(pass|partial|fail)"/i)
  if (!match) return undefined
  const status = match[1]
  return status === 'pass' || status === 'partial' || status === 'fail'
    ? status
    : undefined
}

const outputIndicatesVerifyGateFailure = (output: string) =>
  /gate failed/i.test(output) ||
  /"layoutBoxPassed"\s*:\s*false/.test(output) ||
  /"workflowLintPassed"\s*:\s*false/.test(output) ||
  /"finalOutputPolicyPassed"\s*:\s*false/.test(output) ||
  /"moduleRegionDiffPassed"\s*:\s*false/.test(output) ||
  /"passed"\s*:\s*false/.test(output)

const getAgentCommandStatus = ({
  exitCode,
  output,
}: {
  exitCode: number | null
  output: string
}): 'completed' | 'failed' => {
  if (exitCode !== 0) return 'failed'
  if (outputIndicatesVerifyGateFailure(output)) {
    return 'failed'
  }
  return 'completed'
}

const buildAgentCommandArchiveMaterials = ({
  artifactDir,
  diffRatio,
  htmlPath,
  output,
}: {
  artifactDir: string
  diffRatio?: number
  htmlPath: string
  output: string
}): WorkflowArchiveMaterial[] => {
  const materials: WorkflowArchiveMaterial[] = [
    {
      kind: 'text',
      label: 'Command Output',
      targetName: 'command-output.log',
      content: output || '(empty)',
    },
    {
      kind: 'file',
      label: 'HTML Snapshot',
      sourcePath: htmlPath,
      optional: true,
    },
  ]

  if (diffRatio !== undefined) {
    materials.push(
      {
        kind: 'file',
        label: 'Diff PNG',
        sourcePath: path.join(artifactDir, 'diff.png'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Verify Report JSON',
        sourcePath: path.join(artifactDir, 'verify-report.json'),
        optional: true,
      },
      {
        kind: 'file',
        label: 'Final Output Policy JSON',
        sourcePath: path.join(artifactDir, 'final-output-policy.json'),
        optional: true,
      },
    )
  }

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
    commandKind === 'verify-design' || commandKind === 'verify-module-design'
      ? parseVerifyDiffRatio(output)
      : undefined
  const qualityStatus =
    commandKind === 'verify-design'
      ? parseVerifyQualityStatus(output)
      : undefined
  const normalizedExitCode = typeof exitCode === 'number' ? exitCode : null
  const status = getAgentCommandStatus({
    exitCode: normalizedExitCode,
    output,
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
      qualityStatus,
      source: 'model-agent-turn',
    },
    materials: buildAgentCommandArchiveMaterials({
      artifactDir: session.artifactDir,
      diffRatio,
      htmlPath: session.htmlPath,
      output,
    }),
  })
}

export {
  archiveAgentCommandCheckpoint,
  classifyAgentWorkflowCommand,
  getAgentCommandStatus,
  parseVerifyDiffRatio,
  parseVerifyQualityStatus,
}
