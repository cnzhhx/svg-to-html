import type { PipelineStep, Job, JobMessage } from './job'

export type JobEvent =
  | {
      type: 'init'
      job: Job
      timestamp: number
    }
  | {
      type: 'job:updated'
      jobId: string
      data?: Partial<Job>
      job?: Job
      patch?: Partial<Job>
      timestamp: number
    }
  | {
      type: 'job:deleted'
      jobId: string
      timestamp: number
    }
  | {
      type: 'step:start' | 'step:complete' | 'step:error'
      jobId: string
      step: PipelineStep
      message?: string
      data?: Record<string, unknown>
      timestamp: number
    }
  | {
      type: 'message'
      jobId: string
      message: JobMessage
      timestamp: number
    }
  | {
      type: 'log'
      jobId: string
      message: string
      timestamp: number
    }
  | {
      type: 'agent:event'
      jobId: string
      event: AgentEvent
      timestamp: number
    }
  | {
      type: 'pipeline:complete' | 'pipeline:error'
      jobId: string
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
