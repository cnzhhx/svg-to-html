import {
  appendFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import { stringifyError, truncateText } from './events.js'
import { createSessionPaths, getSessionsRoot } from './paths.js'
import type {
  Session,
  SessionEvent,
  SessionMessage,
  SessionPersistenceState,
} from './types.js'

type VolatileSessionUpdateEmitter = (
  sessionId: string,
  data: Partial<Session>,
) => void

class SessionPersistence {
  private fileWriteQueue = new Map<string, Promise<void>>()

  constructor(
    private readonly sessions: Map<string, Session>,
    private readonly emitVolatileSessionUpdate: VolatileSessionUpdateEmitter,
  ) {}

  persistSnapshot(session: Session) {
    const { snapshotPath } = createSessionPaths(session.sessionDir)
    const payload = `${JSON.stringify(session, null, 2)}\n`
    this.enqueueFileWrite(session.id, snapshotPath, async () => {
      await mkdir(session.sessionDir, { recursive: true })
      const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmpPath, payload, 'utf8')
      await rename(tmpPath, snapshotPath)
    })
  }

  persistMessage(session: Session, message: SessionMessage) {
    const { messagesPath } = createSessionPaths(session.sessionDir)
    const payload = `${JSON.stringify(message)}\n`
    this.enqueueFileWrite(session.id, messagesPath, async () => {
      await mkdir(session.sessionDir, { recursive: true })
      await appendFile(messagesPath, payload, 'utf8')
    })
  }

  persistEvent(session: Session, event: SessionEvent) {
    const { eventsPath } = createSessionPaths(session.sessionDir)
    const payload = `${JSON.stringify(event)}\n`
    this.enqueueFileWrite(session.id, eventsPath, async () => {
      await mkdir(session.sessionDir, { recursive: true })
      await appendFile(eventsPath, payload, 'utf8')
    })
  }

  async deleteSession(session: Session) {
    await this.flushSessionWrites(session)

    const sessionsRoot = path.resolve(getSessionsRoot())
    const sessionDir = path.resolve(session.sessionDir)
    const relative = path.relative(sessionsRoot, sessionDir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        `Refusing to delete session directory outside workspace: ${session.sessionDir}`,
      )
    }

    await rm(sessionDir, { recursive: true, force: true })
  }

  private async flushSessionWrites(session: Session) {
    const { eventsPath, messagesPath, snapshotPath } = createSessionPaths(
      session.sessionDir,
    )
    await Promise.all(
      [eventsPath, messagesPath, snapshotPath].map(
        (filePath) => this.fileWriteQueue.get(filePath) ?? Promise.resolve(),
      ),
    )
  }

  private recordFileWriteFailure(
    sessionId: string,
    filePath: string,
    error: unknown,
  ) {
    const message = stringifyError(error)
    console.error(`[session-store] write failed (${filePath}):`, error)

    const session = this.sessions.get(sessionId)
    if (!session) return

    const persistence: SessionPersistenceState = {
      errorCount: (session.persistence?.errorCount ?? 0) + 1,
      lastErrorAt: Date.now(),
      lastErrorMessage: truncateText(message, 1000),
      lastErrorPath: filePath,
      lastSuccessAt: session.persistence?.lastSuccessAt,
    }
    session.persistence = persistence
    session.updatedAt = Date.now()
    this.emitVolatileSessionUpdate(sessionId, { persistence })
  }

  private recordFileWriteSuccess(sessionId: string) {
    const session = this.sessions.get(sessionId)
    const persistence = session?.persistence
    if (!session || !persistence?.lastErrorAt) return
    if ((persistence.lastSuccessAt ?? 0) >= persistence.lastErrorAt) return

    const nextPersistence = {
      ...persistence,
      lastSuccessAt: Date.now(),
    }
    session.persistence = nextPersistence
    this.emitVolatileSessionUpdate(sessionId, { persistence: nextPersistence })
  }

  private enqueueFileWrite(
    sessionId: string,
    filePath: string,
    write: () => Promise<void>,
  ) {
    // Writes are serialized per file so rapid session updates cannot interleave;
    // persistence failures are recorded on the session instead of rejecting API calls.
    const previous = this.fileWriteQueue.get(filePath) ?? Promise.resolve()
    let next: Promise<void>
    next = previous
      .catch(() => undefined)
      .then(async () => {
        await write()
        this.recordFileWriteSuccess(sessionId)
      })
      .catch((error) => {
        this.recordFileWriteFailure(sessionId, filePath, error)
      })
      .finally(() => {
        if (this.fileWriteQueue.get(filePath) === next) {
          this.fileWriteQueue.delete(filePath)
        }
      })
    this.fileWriteQueue.set(filePath, next)
  }
}

export { SessionPersistence }
