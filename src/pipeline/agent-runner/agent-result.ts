import { sessionStore } from '../../session-store.js'
import { archiveSessionCheckpoint } from './checkpoint.js'
import { createMessageId } from './message-id.js'
import type { RunAgentTurnCoreResult } from './agent-turn-core.js'

const archiveAgentTurn = async ({
  designHtmlPath,
  finalResponse,
  note,
  round,
  sessionId,
  turnSummary,
  usage,
}: {
  designHtmlPath: string
  finalResponse: string
  note: string
  round: number
  sessionId: string
  turnSummary: RunAgentTurnCoreResult['turnSummary']
  usage: RunAgentTurnCoreResult['usage']
}) => {
  await archiveSessionCheckpoint({
    sessionId,
    round,
    stage: 'agent',
    note,
    metadata: {
      outputTokens: usage?.output_tokens ?? null,
      totalInternalRounds: turnSummary.totalInternalRounds,
      totalCommands: turnSummary.totalCommands,
      durationMs: turnSummary.durationMs,
      internalDiffTimeline: turnSummary.internalRounds
        .filter((r) => r.diffRatio !== undefined)
        .map((r) => ({ round: r.roundNumber, diffRatio: r.diffRatio })),
    },
    materials: [
      {
        kind: 'file',
        label: 'HTML Snapshot',
        sourcePath: designHtmlPath,
        optional: true,
      },
      {
        kind: 'text',
        label: 'Agent Response',
        targetName: 'agent-response.md',
        content: finalResponse || '(empty)',
      },
      {
        kind: 'json',
        label: 'Turn Summary',
        targetName: 'turn-summary.json',
        payload: turnSummary,
      },
    ],
  })
}

const addAssistantMessageIfNeeded = ({
  finalResponse,
  hasCompletedAgentMessage,
  sessionId,
}: {
  finalResponse: string
  hasCompletedAgentMessage: boolean
  sessionId: string
}) => {
  if (hasCompletedAgentMessage || !finalResponse.trim()) return
  sessionStore.addMessage(sessionId, {
    id: createMessageId('assistant'),
    kind: 'chat',
    role: 'assistant',
    text: finalResponse,
  })
}

const completeAgentStepWithUsage = ({
  compareHtmlPath,
  finalResponse,
  htmlPath,
  sessionId,
  usage,
}: {
  compareHtmlPath: string
  finalResponse?: string
  htmlPath: string
  sessionId: string
  usage: RunAgentTurnCoreResult['usage']
}) => {
  const prevTokens = Number(
    sessionStore.get(sessionId)?.result?.tokensUsed ?? 0,
  )
  const prevInput = Number(
    sessionStore.get(sessionId)?.result?.inputTokens ?? 0,
  )
  const prevOutput = Number(
    sessionStore.get(sessionId)?.result?.outputTokens ?? 0,
  )
  sessionStore.completeStep(sessionId, 'agent', {
    agentResponse: finalResponse,
    compareHtmlPath,
    htmlPath,
    tokensUsed:
      prevTokens + (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    inputTokens: prevInput + (usage?.input_tokens ?? 0),
    outputTokens: prevOutput + (usage?.output_tokens ?? 0),
  })
}

const completeAgentTurnWithUsage = ({
  compareHtmlPath,
  finalResponse,
  hasCompletedAgentMessage,
  htmlPath,
  sessionId,
  usage,
}: {
  compareHtmlPath: string
  finalResponse: string
  hasCompletedAgentMessage: boolean
  htmlPath: string
  sessionId: string
  usage: RunAgentTurnCoreResult['usage']
}) => {
  completeAgentStepWithUsage({
    compareHtmlPath,
    finalResponse,
    htmlPath,
    sessionId,
    usage,
  })
  addAssistantMessageIfNeeded({
    finalResponse,
    hasCompletedAgentMessage,
    sessionId,
  })
}

export { archiveAgentTurn, completeAgentTurnWithUsage }
