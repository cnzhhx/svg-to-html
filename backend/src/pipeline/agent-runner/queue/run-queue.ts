import { sessionStore } from '../../../session-store.js'

type RunSession = (
  sessionId: string,
  controller: AbortController,
) => Promise<void>

type MaxConcurrentAgentsInput = number | (() => number)

const createAgentRunQueue = ({
  maxConcurrentAgents,
  runSession,
}: {
  maxConcurrentAgents: MaxConcurrentAgentsInput
  runSession: RunSession
}) => {
  const queue: string[] = []
  const queued = new Set<string>()
  const activeRuns = new Map<
    string,
    {
      controller: AbortController
      finished: Promise<void>
      resolveFinished: () => void
    }
  >()

  const reserveRunSlot = (sessionId: string) => {
    const existing = activeRuns.get(sessionId)
    if (existing) return existing
    const controller = new AbortController()
    let resolveFinished = () => {}
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const runState = { controller, finished, resolveFinished }
    activeRuns.set(sessionId, runState)
    return runState
  }

  const getMaxConcurrentAgents = () =>
    Math.max(
      1,
      Math.floor(
        typeof maxConcurrentAgents === 'function'
          ? maxConcurrentAgents()
          : maxConcurrentAgents,
      ),
    )

  const broadcastQueuePositions = () => {
    for (let i = 0; i < queue.length; i++) {
      const sid = queue[i]!
      const position = i + 1
      sessionStore.updateQueuePosition(sid, position, queue.length)
    }
  }

  const refillQueueFromStore = () => {
    const queuedSessions = sessionStore
      .list()
      .filter(
        (session) =>
          session.status === 'queued' &&
          !queued.has(session.id) &&
          !activeRuns.has(session.id),
      )
      .sort((left, right) => {
        const leftQueuedAt = left.queuedAt ?? left.createdAt
        const rightQueuedAt = right.queuedAt ?? right.createdAt
        if (leftQueuedAt !== rightQueuedAt) return leftQueuedAt - rightQueuedAt
        return left.createdAt - right.createdAt
      })

    for (const session of queuedSessions) {
      queue.push(session.id)
      queued.add(session.id)
    }
  }

  const processQueue = () => {
    refillQueueFromStore()
    while (activeRuns.size < getMaxConcurrentAgents() && queue.length > 0) {
      const sessionId = queue.shift()!
      queued.delete(sessionId)
      const activeRun = reserveRunSlot(sessionId)
      void runSession(sessionId, activeRun.controller)
        .catch((error) => {
          console.error(`[agent-runner] runSession(${sessionId}) uncaught:`, error)
          const message = error instanceof Error ? error.message : String(error)
          sessionStore.failPipeline(sessionId, message)
        })
        .finally(() => {
          activeRun.resolveFinished()
          activeRuns.delete(sessionId)
          processQueue()
        })
    }
    broadcastQueuePositions()
  }

  const processQueuedSessions = () => {
    processQueue()
  }

  const enqueueSession = (sessionId: string) => {
    if (queued.has(sessionId) || activeRuns.has(sessionId)) return
    sessionStore.markQueued(sessionId)
    queue.push(sessionId)
    queued.add(sessionId)
    processQueue()
    broadcastQueuePositions()
  }

  const removeFromQueue = (sessionId: string) => {
    const index = queue.indexOf(sessionId)
    const removed = index >= 0
    if (removed) queue.splice(index, 1)
    queued.delete(sessionId)
    broadcastQueuePositions()
    return removed
  }

  const cancelSessionRun = (sessionId: string) => {
    const removedQueued = removeFromQueue(sessionId)
    const active = activeRuns.get(sessionId)
    if (!active) return { active: false as const, queued: removedQueued }
    sessionStore.addLog(sessionId, '[agent] session delete requested; canceling run')
    active.controller.abort('deleted-by-user')
    return { active: true as const, finished: active.finished, queued: false }
  }

  return {
    cancelSessionRun,
    enqueueSession,
    processQueuedSessions,
  }
}

export { createAgentRunQueue }
