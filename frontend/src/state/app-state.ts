import type { AgentEvent } from '../types/events'
import type { RuntimeInfo } from '../types/runtime'
import type { Job, JobSummary } from '../types/job'
import { STORAGE_KEYS, readNumberStorage, readStringStorage } from '../utils/storage'

export type ResultViewMode = 'split' | 'slider'

export type AppState = {
  agentEvents: AgentEvent[]
  chatFilterModuleId: string | null
  chatOpen: boolean
  currentJob: Job | null
  currentJobId: string | null
  error: string | null
  loading: boolean
  resultComparePosition: number
  resultPreviewWidth: number
  resultViewMode: ResultViewMode
  runtime: RuntimeInfo | null
  selectedModuleId: string | null
  jobs: JobSummary[]
  uploadDialogOpen: boolean
}

const readResultViewMode = (): ResultViewMode => {
  const value = readStringStorage(STORAGE_KEYS.resultViewMode, 'split')
  return value === 'slider' ? 'slider' : 'split'
}

export const initialAppState: AppState = {
  agentEvents: [],
  chatFilterModuleId: null,
  chatOpen: false,
  currentJob: null,
  currentJobId: null,
  error: null,
  loading: true,
  resultComparePosition: Math.min(95, Math.max(5, readNumberStorage(STORAGE_KEYS.resultComparePosition, 50))),
  resultPreviewWidth: Math.min(960, Math.max(375, readNumberStorage(STORAGE_KEYS.resultPreviewWidth, 375))),
  resultViewMode: readResultViewMode(),
  runtime: null,
  selectedModuleId: null,
  jobs: [],
  uploadDialogOpen: false,
}
