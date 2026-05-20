import { sessionStore } from '../../session-store.js'
import type { AgentThread } from '../agent-runtime/index.js'
import {
  AGENT_VERIFY_MIN_IMPROVEMENT,
  MAX_AGENT_STALLED_VERIFY_RUNS,
  MAX_AGENT_TURN_COMMANDS,
  MAX_AGENT_TURN_VERIFY_RUNS,
  MIN_AGENT_VERIFY_RUNS_BEFORE_STALL_STOP,
} from './config.js'
import {
  archiveAgentCommandCheckpoint,
  classifyAgentWorkflowCommand,
  getAgentCommandStatus,
  parseVerifyDiffRatio,
  parseVerifyQualityStatus,
} from './agent-turn-command.js'
import { logThreadEvent } from './agent-turn-events.js'
import { isAbortError } from './run-control.js'

import type {
  AgentCommandRecord,
  AgentInternalRound,
  AgentMessageRecord,
  AgentTurnSummary,
} from './agent-turn-types.js'

type RunAgentTurnCoreInput = {
  thread: AgentThread
  prompt: string
  round: number
  sessionId: string
  controller: AbortController
  updateSessionThread?: boolean
}

type RunAgentTurnCoreResult = {
  finalResponse: string
  hasCompletedAgentMessage: boolean
  turnSummary: AgentTurnSummary
  usage: null | { input_tokens: number; output_tokens: number }
}

const buildInternalRounds = ({
  allCommands,
  completedInternalRounds,
  turnStartedAt,
}: {
  allCommands: AgentCommandRecord[]
  completedInternalRounds: number
  turnStartedAt: number
}) => {
  const internalRounds: AgentInternalRound[] = []
  for (let r = 1; r <= Math.max(completedInternalRounds, 1); r++) {
    const roundCommands = allCommands.filter((c) => c.internalRound === r)
    const verifyCmd = roundCommands.find(
      (c) => c.diffRatio !== undefined,
    )
    internalRounds.push({
      commands: roundCommands,
      diffRatio: verifyCmd?.diffRatio,
      endedAt: verifyCmd?.completedAt,
      roundNumber: r,
      startedAt:
        roundCommands[0]?.startedAt ??
        roundCommands[0]?.completedAt ??
        turnStartedAt,
    })
  }
  return internalRounds
}

const logTurnSummary = ({
  allCommands,
  completedInternalRounds,
  internalRounds,
  sessionId,
  turnSummary,
}: {
  allCommands: AgentCommandRecord[]
  completedInternalRounds: number
  internalRounds: AgentInternalRound[]
  sessionId: string
  turnSummary: AgentTurnSummary
}) => {
  if (completedInternalRounds <= 0) return
  const diffTimeline = internalRounds
    .filter((r) => r.diffRatio !== undefined)
    .map((r) => `round${r.roundNumber}=${(r.diffRatio! * 100).toFixed(2)}%`)
    .join(' → ')
  sessionStore.addLog(
    sessionId,
    `[agent:summary] ${completedInternalRounds} internal round(s), ${turnSummary.totalShellCommands ?? allCommands.length} shell command(s), ${allCommands.length} workflow command(s), ${(turnSummary.durationMs / 1000).toFixed(1)}s` +
      (diffTimeline ? `, diff: ${diffTimeline}` : '') +
      (turnSummary.verifyUsage.verifyCount > 0
        ? `, verify runs: ${turnSummary.verifyUsage.verifyCount}` +
          (turnSummary.verifyUsage.bestDiffRatio !== undefined
            ? `, best=${(turnSummary.verifyUsage.bestDiffRatio * 100).toFixed(2)}%`
            : '')
        : '') +
      (turnSummary.earlyStopReason
        ? `, earlyStop=${turnSummary.earlyStopReason}`
        : ''),
  )
}

/**
 * 核心 agent turn 执行逻辑，解耦自 runAgentTurn
 *
 * 与 runAgentTurn 的区别：
 * - 接受外部提供的 thread（不再从 session 解析）
 * - 不依赖 session.threadId 复用机制
 * - 保留所有核心能力：stall 检测、early stop、verify 用量统计、archive
 */
export async function runAgentTurnCore(
  input: RunAgentTurnCoreInput,
): Promise<RunAgentTurnCoreResult> {
  const {
    thread,
    prompt,
    round,
    sessionId,
    controller,
    updateSessionThread = true,
  } = input

  const turnController = new AbortController()
  const relayRunAbort = () => turnController.abort(controller.signal.reason)
  if (controller.signal.aborted) relayRunAbort()
  controller.signal.addEventListener('abort', relayRunAbort, { once: true })

  const streamedTurn = await thread.runStreamed(prompt, {
    signal: turnController.signal,
  })

  let finalResponse = ''
  let hasCompletedAgentMessage = false
  let usage: null | { input_tokens: number; output_tokens: number } = null

  const allCommands: AgentCommandRecord[] = []
  const allMessages: AgentMessageRecord[] = []
  let internalRound = 1
  let bestVerifyDiffRatio: number | undefined
  let stalledVerifyRuns = 0
  let verifyRunCount = 0
  let completedShellCommandCount = 0
  let earlyStopReason: string | undefined
  let lastVerifyQualityStatus: 'pass' | 'partial' | 'fail' | undefined
  const commandStartTimes = new Map<string, number>()
  const turnStartedAt = Date.now()

  const maybeStopTurnEarly = () => {
    if (earlyStopReason || controller.signal.aborted) return
    if (
      verifyRunCount >= MAX_AGENT_TURN_VERIFY_RUNS &&
      MAX_AGENT_TURN_VERIFY_RUNS > 0
    ) {
      earlyStopReason = `verify run limit reached (${verifyRunCount}/${MAX_AGENT_TURN_VERIFY_RUNS})`
    }

    if (earlyStopReason) {
      sessionStore.addLog(
        sessionId,
        `[agent:early-stop] ${earlyStopReason}; stopping this turn and keeping the best verified state for the host workflow`,
      )
      turnController.abort('early-stopping')
      return
    }

    const qualityAllowsEarlyStop =
      lastVerifyQualityStatus === 'pass' ||
      lastVerifyQualityStatus === 'partial'
    if (!qualityAllowsEarlyStop) return

    if (
      stalledVerifyRuns >= MAX_AGENT_STALLED_VERIFY_RUNS &&
      MAX_AGENT_STALLED_VERIFY_RUNS > 0 &&
      verifyRunCount >= MIN_AGENT_VERIFY_RUNS_BEFORE_STALL_STOP
    ) {
      earlyStopReason = `no material diff improvement across ${stalledVerifyRuns} verify run(s)`
    } else if (
      completedShellCommandCount >= MAX_AGENT_TURN_COMMANDS &&
      MAX_AGENT_TURN_COMMANDS > 0 &&
      verifyRunCount > 0
    ) {
      earlyStopReason = `command limit reached (${completedShellCommandCount}/${MAX_AGENT_TURN_COMMANDS}) after verification began`
    }

    if (!earlyStopReason) return
    sessionStore.addLog(
      sessionId,
      `[agent:early-stop] ${earlyStopReason}; stopping this turn and keeping the best verified state for the host workflow`,
    )
    turnController.abort('early-stopping')
  }

  try {
    for await (const event of streamedTurn.events) {
      logThreadEvent(sessionId, event, { updateSessionThread })

      if (
        event.type === 'item.started' &&
        event.item.type === 'command_execution'
      ) {
        commandStartTimes.set(event.item.id, Date.now())
      }

      if (
        event.type === 'item.completed' &&
        event.item.type === 'command_execution'
      ) {
        completedShellCommandCount++
        const commandKind = classifyAgentWorkflowCommand(event.item.command)
        if (commandKind) {
          const output = event.item.aggregated_output ?? ''
          const exitCode =
            typeof event.item.exit_code === 'number'
              ? event.item.exit_code
              : null
          const diffRatio =
            commandKind === 'verify-design' ||
            commandKind === 'verify-module-design'
              ? parseVerifyDiffRatio(output)
              : undefined
          const qualityStatus =
            commandKind === 'verify-design'
              ? parseVerifyQualityStatus(output)
              : undefined
          const status = getAgentCommandStatus({
            exitCode,
            output,
          })

          allCommands.push({
            command: event.item.command,
            commandKind,
            completedAt: Date.now(),
            diffRatio,
            exitCode,
            internalRound,
            qualityStatus,
            startedAt: commandStartTimes.get(event.item.id),
            status,
          })

          if (
            commandKind === 'verify-design' ||
            commandKind === 'verify-module-design'
          ) {
            verifyRunCount++
            if (diffRatio !== undefined) {
              const materiallyImproved =
                bestVerifyDiffRatio === undefined ||
                bestVerifyDiffRatio - diffRatio >= AGENT_VERIFY_MIN_IMPROVEMENT
              stalledVerifyRuns = materiallyImproved ? 0 : stalledVerifyRuns + 1
              bestVerifyDiffRatio =
                bestVerifyDiffRatio === undefined
                  ? diffRatio
                  : Math.min(bestVerifyDiffRatio, diffRatio)
            }
            lastVerifyQualityStatus = qualityStatus
          }

          await archiveAgentCommandCheckpoint({
            command: event.item.command,
            commandKind,
            exitCode: event.item.exit_code,
            internalRound,
            output,
            round,
            sessionId,
          })

          if (
            commandKind === 'verify-design' ||
            commandKind === 'verify-module-design'
          ) {
            const diffSummary =
              diffRatio === undefined
                ? 'diffRatio=n/a'
                : `diffRatio=${(diffRatio * 100).toFixed(2)}%`
            sessionStore.addLog(
              sessionId,
              `[agent:internal] round ${internalRound} verify ${status}: ${diffSummary}`,
            )
            internalRound++
          }
        }
        maybeStopTurnEarly()
      }

      if (
        event.type === 'item.completed' &&
        event.item.type === 'agent_message'
      ) {
        finalResponse = event.item.text
        hasCompletedAgentMessage = true
        if (event.item.text) {
          allMessages.push({
            internalRound,
            text: event.item.text,
            timestamp: Date.now(),
          })
        }
      }

      if (event.type === 'turn.completed') {
        usage = {
          input_tokens: event.usage.input_tokens,
          output_tokens: event.usage.output_tokens,
        }
      }
      if (event.type === 'turn.failed') {
        throw new Error(event.error.message)
      }
    }
  } catch (error) {
    if (!earlyStopReason || controller.signal.aborted || !isAbortError(error)) {
      throw error
    }
    finalResponse =
      finalResponse ||
      `Early stopping triggered: ${earlyStopReason}. Host workflow will continue from the latest verified artifacts.`
    hasCompletedAgentMessage = true
  } finally {
    controller.signal.removeEventListener('abort', relayRunAbort)
  }

  const completedInternalRounds = internalRound - 1
  const internalRounds = buildInternalRounds({
    allCommands,
    completedInternalRounds,
    turnStartedAt,
  })
  const turnEndedAt = Date.now()
  const turnSummary: AgentTurnSummary = {
    commands: allCommands,
    durationMs: turnEndedAt - turnStartedAt,
    earlyStopReason,
    endedAt: turnEndedAt,
    internalRounds,
    messages: allMessages,
    startedAt: turnStartedAt,
    totalShellCommands: completedShellCommandCount,
    totalCommands: allCommands.length,
    totalInternalRounds: completedInternalRounds,
    usage,
    verifyUsage: {
      bestDiffRatio: bestVerifyDiffRatio,
      verifyCount: verifyRunCount,
    },
  }

  logTurnSummary({
    allCommands,
    completedInternalRounds,
    internalRounds,
    sessionId,
    turnSummary,
  })

  return { finalResponse, hasCompletedAgentMessage, turnSummary, usage }
}

export type { RunAgentTurnCoreResult }
