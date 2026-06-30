import type { AgentEvent } from '../types/events'
import type { RuntimeInfo } from '../types/runtime'
import type { Session, SessionMessage, SessionSummary } from '../types/session'
import type { ResultViewMode } from './app-state'

export type AppAction =
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'chat/filter'; moduleId: string | null }
  | { type: 'chat/toggle'; open?: boolean }
  | { type: 'error/set'; error: string | null }
  | { type: 'message/upserted'; message: SessionMessage; timestamp?: number }
  | { type: 'module/select'; moduleId: string | null }
  | { type: 'pipeline/completed'; sessionId: string; timestamp?: number }
  | { type: 'pipeline/failed'; message?: string; sessionId: string; timestamp?: number }
  | { type: 'result/compare-position'; value: number }
  | { type: 'result/preview-width'; value: number }
  | { type: 'result/view-mode'; value: ResultViewMode }
  | { type: 'runtime/loaded'; runtime: RuntimeInfo }
  | { type: 'session/deleted'; sessionId: string }
  | { type: 'session/init'; session: Session }
  | { type: 'session/selected'; session: Session | null; sessionId: string | null }
  | { type: 'session/updated'; data: Partial<Session>; sessionId: string; timestamp?: number }
  | { type: 'sessions/loaded'; sessions: SessionSummary[] }
  | { type: 'settings/open'; open: boolean }
  | { type: 'upload/open'; open: boolean }
