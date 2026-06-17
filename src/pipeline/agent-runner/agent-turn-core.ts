import { sessionStore } from '../../session-store.js'
import type { AgentInput, AgentThread } from '../agent-runtime/index.js'
import {
  AGENT_VERIFY_MIN_IMPROVEMENT,
  AGENT_VERIFY_ROLLBACK_THRESHOLD,
  MAX_AGENT_STALLED_VERIFY_RUNS,
  MAX_AGENT_TURN_COMMANDS,
  MAX_AGENT_TURN_VERIFY_RUNS,
} from './config.js'
import {
  archiveAgentCommandCheckpoint,
  classifyAgentWorkflowCommand,
  getAgentCommandStatus,
  parseVerifyDiffRatio,
} from './agent-turn-command.js'
import { logThreadEvent } from './agent-turn-events.js'
import { isAbortError } from './run-control.js'
import { backupBestFiles, restoreBestFiles } from './rollback-utils.js'

import type {
  AgentCommandKind,
  AgentCommandRecord,
  AgentInternalRound,
  AgentMessageRecord,
  AgentTokenUsage,
  AgentTurnMetrics,
  AgentTurnSummary,
} from './agent-turn-types.js'

type RunAgentTurnCoreInput = {
  thread: AgentThread
  input: AgentInput
  round: number
  sessionId: string
  controller: AbortController
  eventSourceLabel?: string
  moduleId?: string
  onThreadStarted?: (threadId: string) => void
  updateSessionThread?: boolean
  moduleTimeoutMs?: number
  rollbackBackupRoot?: string
  rollbackFiles?: string[]
}

type RunAgentTurnCoreResult = {
  finalResponse: string
  hasCompletedAgentMessage: boolean
  turnSummary: AgentTurnSummary
  usage: AgentTokenUsage | null
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
    input: agentInput,
    round,
    sessionId,
    controller,
    eventSourceLabel,
    moduleId,
    onThreadStarted,
    updateSessionThread = true,
    moduleTimeoutMs,
  } = input

  const turnController = new AbortController()
  const relayRunAbort = () => turnController.abort(controller.signal.reason)
  if (controller.signal.aborted) relayRunAbort()
  controller.signal.addEventListener('abort', relayRunAbort, { once: true })

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  if (moduleTimeoutMs && moduleTimeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (earlyStopReason || turnController.signal.aborted) return
      earlyStopReason = `module-timeout (${Math.round(moduleTimeoutMs / 1000)}s)`
      sessionStore.addLog(
        sessionId,
        `[agent:${eventSourceLabel ?? moduleId ?? 'turn'}] ${earlyStopReason}; stopping this turn and keeping the best verified state`,
      )
      turnController.abort('module-timeout')
    }, moduleTimeoutMs)
  }

  const streamedTurn = await thread.runStreamed(agentInput, {
    signal: turnController.signal,
  })

  let finalResponse = ''
  let hasCompletedAgentMessage = false
  let usage: AgentTokenUsage | null = null
  let metrics: AgentTurnMetrics | undefined
  let pendingThreadId: string | null = null
  let notifiedThreadId: string | null = null

  const allCommands: AgentCommandRecord[] = []
  const allMessages: AgentMessageRecord[] = []
  let internalRound = 1
  let bestVerifyDiffRatio: number | undefined
  let browserEvalBaselineBackedUp = false
  let stalledVerifyRuns = 0
  let verifyRunCount = 0
  let completedShellCommandCount = 0
  let earlyStopReason: string | undefined
  let rollbackCount = 0
  let rollbackReasons: string[] = []

  const commandStartTimes = new Map<string, number>()
  const turnStartedAt = Date.now()

  const maybeStopTurnEarly = () => {
    if (earlyStopReason || controller.signal.aborted || turnController.signal.aborted) return
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
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      return
    }

    if (
      stalledVerifyRuns >= MAX_AGENT_STALLED_VERIFY_RUNS &&
      MAX_AGENT_STALLED_VERIFY_RUNS > 0
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

  const handleBrowserEvalCheckpoint = async () => {
    if (!input.rollbackFiles || input.rollbackFiles.length === 0) return
    const session = sessionStore.get(sessionId)
    if (!session) return
    await backupBestFiles(
      input.rollbackBackupRoot ?? session.artifactDir,
      input.rollbackFiles,
    )
    if (!browserEvalBaselineBackedUp) {
      browserEvalBaselineBackedUp = true
      sessionStore.addLog(
        sessionId,
        `[agent:browser-eval] baseline snapshot saved before verify`,
      )
    } else {
      sessionStore.addLog(
        sessionId,
        `[agent:browser-eval] checkpoint snapshot saved after browser-eval`,
      )
    }
  }

  try {
    for await (const event of streamedTurn.events) {
      if (
        event.type === 'thread.started' &&
        event.thread_id !== pendingThreadId
      ) {
        pendingThreadId = event.thread_id
      }
      logThreadEvent(sessionId, event, {
        eventSourceLabel,
        moduleId,
        updateSessionThread,
      })

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
            commandKind === 'verify-module-design' ||
            commandKind === 'verify-module-framework'
              ? parseVerifyDiffRatio(output)
              : undefined
          const status = getAgentCommandStatus({
            exitCode,
          })

          allCommands.push({
            command: event.item.command,
            commandKind,
            completedAt: Date.now(),
            diffRatio,
            exitCode,
            internalRound,
            startedAt: commandStartTimes.get(event.item.id),
            status,
          })

          if (
            commandKind === 'verify-design' ||
            commandKind === 'verify-module-design' ||
            commandKind === 'verify-module-framework'
          ) {
            verifyRunCount++
            if (diffRatio !== undefined) {
              const materiallyImproved =
                bestVerifyDiffRatio === undefined ||
                bestVerifyDiffRatio - diffRatio >= AGENT_VERIFY_MIN_IMPROVEMENT
              const degraded =
                bestVerifyDiffRatio !== undefined &&
                diffRatio > bestVerifyDiffRatio + AGENT_VERIFY_ROLLBACK_THRESHOLD

              if (degraded && input.rollbackFiles && input.rollbackFiles.length > 0) {
                const session = sessionStore.get(sessionId)
                if (session) {
                  await restoreBestFiles(
                    input.rollbackBackupRoot ?? session.artifactDir,
                    input.rollbackFiles,
                  )
                }
                rollbackCount++
                rollbackReasons.push(
                  `round ${internalRound}: diff ${(bestVerifyDiffRatio! * 100).toFixed(2)}% → ${(diffRatio * 100).toFixed(2)}%`,
                )
                sessionStore.addLog(
                  sessionId,
                  `[agent:rollback] #${rollbackCount}: diff degraded from ${(bestVerifyDiffRatio! * 100).toFixed(2)}% to ${(diffRatio * 100).toFixed(2)}%; rolled back`,
                )

                earlyStopReason = `verify-rollback-${rollbackCount}: diff degraded from ${(bestVerifyDiffRatio! * 100).toFixed(2)}% to ${(diffRatio * 100).toFixed(2)}%`
                stalledVerifyRuns = 0
                turnController.abort(earlyStopReason)
              } else {
                stalledVerifyRuns = materiallyImproved ? 0 : stalledVerifyRuns + 1
                if (
                  bestVerifyDiffRatio === undefined ||
                  diffRatio < bestVerifyDiffRatio
                ) {
                  bestVerifyDiffRatio = diffRatio
                  if (input.rollbackFiles && input.rollbackFiles.length > 0) {
                    const session = sessionStore.get(sessionId)
                    if (session) {
                      await backupBestFiles(
                        input.rollbackBackupRoot ?? session.artifactDir,
                        input.rollbackFiles,
                      )
                    }
                  }
                }
              }
            }

          } else if (commandKind === 'browser-eval' && status === 'completed') {
            await handleBrowserEvalCheckpoint()
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
            commandKind === 'verify-module-design' ||
            commandKind === 'verify-module-framework'
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
          } else if (commandKind === 'browser-eval') {
            sessionStore.addLog(
              sessionId,
              `[agent:internal] round ${internalRound} browser-eval ${status}`,
            )
          }
        }
        maybeStopTurnEarly()
      }

      if (
        event.type === 'item.completed' &&
        event.item.type === 'mcp_tool_call' &&
        event.item.tool === 'browser_eval'
      ) {
        completedShellCommandCount++
        const commandKind: AgentCommandKind = 'browser-eval'
        const status = event.item.status === 'failed' ? 'failed' : 'completed'

        allCommands.push({
          command: `[mcp] browser_eval(${event.item.server ?? 'browser-session'})`,
          commandKind,
          completedAt: Date.now(),
          exitCode: status === 'completed' ? 0 : 1,
          internalRound,
          startedAt: commandStartTimes.get(event.item.id),
          status,
        })

        if (status === 'completed') {
          await handleBrowserEvalCheckpoint()
        }

        await archiveAgentCommandCheckpoint({
          command: `[mcp] browser_eval`,
          commandKind,
          exitCode: status === 'completed' ? 0 : 1,
          internalRound,
          output:
            status === 'completed'
              ? 'MCP browser_eval completed'
              : `MCP browser_eval failed: ${String(event.item.result ?? event.item.error?.message ?? 'unknown error')}`,
          round,
          sessionId,
        })

        sessionStore.addLog(
          sessionId,
          `[agent:internal] round ${internalRound} browser-eval ${status} (mcp)`,
        )
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
        if (pendingThreadId && pendingThreadId !== notifiedThreadId) {
          notifiedThreadId = pendingThreadId
          onThreadStarted?.(pendingThreadId)
        }
        usage = {
          cached_input_tokens: event.usage.cached_input_tokens,
          input_tokens: event.usage.input_tokens,
          output_tokens: event.usage.output_tokens,
        }
      }
      if (event.type === 'turn.metrics') {
        metrics = event.metrics
      }
      if (event.type === 'turn.failed') {
        throw new Error(event.error.message)
      }
    }
  } catch (error) {
    if (!earlyStopReason || controller.signal.aborted || !isAbortError(error)) {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      throw error
    }
    finalResponse =
      finalResponse ||
      `Early stopping triggered: ${earlyStopReason}. Host workflow will continue from the latest verified artifacts.`
    hasCompletedAgentMessage = true
  } finally {
    controller.signal.removeEventListener('abort', relayRunAbort)
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
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
    metrics,
    startedAt: turnStartedAt,
    totalShellCommands: completedShellCommandCount,
    totalCommands: allCommands.length,
    totalInternalRounds: completedInternalRounds,
    usage,
    verifyUsage: {
      bestDiffRatio: bestVerifyDiffRatio,
      verifyCount: verifyRunCount,
      rollbackCount,
      rollbackReasons,
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
