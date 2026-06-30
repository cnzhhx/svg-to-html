import type { PipelineStep, Session, SessionMessage } from './session'

export type SessionEvent =
  | {
      type: 'init'
      session: Session
      timestamp: number
    }
  | {
      type: 'session:updated'
      sessionId: string
      data: Partial<Session>
      timestamp: number
    }
  | {
      type: 'session:deleted'
      sessionId: string
      timestamp: number
    }
  | {
      type: 'step:start' | 'step:complete' | 'step:error'
      sessionId: string
      step: PipelineStep
      message?: string
      data?: Record<string, unknown>
      timestamp: number
    }
  | {
      type: 'message'
      sessionId: string
      message: SessionMessage
      timestamp: number
    }
  | {
      type: 'log'
      sessionId: string
      message: string
      timestamp: number
    }
  | {
      type: 'agent:event'
      sessionId: string
      event: AgentEvent
      timestamp: number
    }
  | {
      type: 'pipeline:complete' | 'pipeline:error'
      sessionId: string
      message?: string
      timestamp: number
    }

export type AgentEvent = Record<string, unknown> & {
  type?: string
  moduleId?: string
  sourceLabel?: string
  timestamp?: number
  item?: Record<string, unknown> & {
    id?: string
    type?: string
    text?: string
    status?: string
    command?: string
    aggregated_output?: string
    message?: string
    server?: string
    tool?: string
    result?: unknown
    error?: { message?: string }
  }
}
