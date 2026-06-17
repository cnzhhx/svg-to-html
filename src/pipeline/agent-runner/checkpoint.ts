import path from 'node:path'

import { sessionStore } from '../../session-store.js'
import {
  archiveWorkflowCheckpoint,
  type WorkflowArchiveMaterial,
} from '../workflow-archive.js'

type ArchiveSessionCheckpointStage =
  | 'analysis'
  | 'agent'
  | 'agent-command'
  | 'verify'

const archiveSessionCheckpoint = async ({
  diffRatio,
  materials,
  metadata,
  note,
  round,
  sessionId,
  stage,
}: {
  diffRatio?: number
  materials: WorkflowArchiveMaterial[]
  metadata?: Record<string, unknown>
  note?: string
  round: number
  sessionId: string
  stage: ArchiveSessionCheckpointStage
}) => {
  const session = sessionStore.get(sessionId)
  if (!session) return

  try {
    const entry = await archiveWorkflowCheckpoint({
      artifactDir: session.artifactDir,
      diffRatio,
      materials,
      metadata,
      note,
      round,
      stage,
    })
    sessionStore.addWorkflowArchive(sessionId, entry)
    sessionStore.addLog(
      sessionId,
      `[archive] round ${round} ${stage} saved: ${path.relative(session.sessionDir, entry.dir)}`,
    )
  } catch (error) {
    sessionStore.addLog(
      sessionId,
      `[archive] round ${round} ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export { archiveSessionCheckpoint }
