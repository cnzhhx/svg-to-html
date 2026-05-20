import path from 'node:path'
import { mkdir, readdir, readFile } from 'node:fs/promises'

import { createSessionPaths, getSessionsRoot } from './paths.js'
import { ensureWorkflowProgress } from './progress.js'
import type { Session } from './types.js'

const loadSessionSnapshots = async (): Promise<Session[]> => {
  const root = getSessionsRoot()
  await mkdir(root, { recursive: true })
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sessions: Session[] = []

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const { snapshotPath } = createSessionPaths(path.join(root, entry.name))
    try {
      const raw = await readFile(snapshotPath, 'utf8')
      const session = JSON.parse(raw) as Session
      ensureWorkflowProgress(session)
      sessions.push(session)
    } catch {
      // Ignore broken session snapshots and keep booting.
    }
  }

  return sessions
}

export { loadSessionSnapshots }
