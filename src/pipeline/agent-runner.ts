import { MAX_CONCURRENT_AGENTS } from './agent-runner/config.js'
import { createAgentRunQueue } from './agent-runner/run-queue.js'
import { runSession } from './agent-runner/session-runner.js'

const agentRunQueue = createAgentRunQueue({
  maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
  runSession,
})

const { cancelSessionRun, enqueueSession, processQueuedSessions } = agentRunQueue

export { cancelSessionRun, enqueueSession, processQueuedSessions }
