import path from 'node:path'

import { getWorkspaceRoot } from '../core/utils.js'

const getSessionsRoot = () => path.join(getWorkspaceRoot(), 'sessions')

const createSessionPaths = (sessionDir: string) => ({
  eventsPath: path.join(sessionDir, 'events.jsonl'),
  messagesPath: path.join(sessionDir, 'messages.jsonl'),
  snapshotPath: path.join(sessionDir, 'session.json'),
})

export { createSessionPaths, getSessionsRoot }
