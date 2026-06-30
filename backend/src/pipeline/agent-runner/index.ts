import { getMaxConcurrentAgents } from '../../config/index.js'
import { createAgentRunQueue } from './queue/run-queue.js'
import { runSession } from './session/session-runner.js'

const agentRunQueue = createAgentRunQueue({
  maxConcurrentAgents: getMaxConcurrentAgents,
  runSession,
})

const { cancelSessionRun, enqueueSession, processQueuedSessions } = agentRunQueue

export { cancelSessionRun, enqueueSession, processQueuedSessions }
