import type { AgentEvent } from '../types/events'
import type { RuntimeInfo } from '../types/runtime'
import type { Job, JobMessage, JobSummary } from '../types/job'
import type { ResultViewMode } from './app-state'

export type AppAction =
  | { type: 'agent/event'; event: AgentEvent }
  | { type: 'chat/filter'; moduleId: string | null }
  | { type: 'chat/toggle'; open?: boolean }
  | { type: 'error/set'; error: string | null }
  | { type: 'message/upserted'; message: JobMessage; timestamp?: number }
  | { type: 'module/select'; moduleId: string | null }
  | { type: 'pipeline/completed'; jobId: string; timestamp?: number }
  | { type: 'pipeline/failed'; message?: string; jobId: string; timestamp?: number }
  | { type: 'result/compare-position'; value: number }
  | { type: 'result/preview-width'; value: number }
  | { type: 'result/view-mode'; value: ResultViewMode }
  | { type: 'runtime/loaded'; runtime: RuntimeInfo }
  | { type: 'job/deleted'; jobId: string }
  | { type: 'job/init'; job: Job }
  | { type: 'job/selected'; job: Job | null; jobId: string | null }
  | { type: 'job/updated'; data: Partial<Job>; jobId: string; timestamp?: number }
  | { type: 'jobs/loaded'; jobs: JobSummary[] }
  | { type: 'jobs/refreshed'; jobs: JobSummary[] }
  | { type: 'upload/open'; open: boolean }
