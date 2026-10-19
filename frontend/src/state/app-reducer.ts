import type { Job, JobMessage, JobSummary } from '../types/job'
import { saveLocalJobSnapshot } from '../utils/local-job'
import { collectSelectableModules } from '../utils/modules'
import type { AppAction } from './actions'
import type { AppState } from './app-state'

const upsertJob = (jobs: JobSummary[], job: Job): JobSummary[] => {
  const existing = jobs.findIndex((item) => item.id === job.id)
  const next = existing >= 0 ? [...jobs] : [job, ...jobs]
  if (existing >= 0) next[existing] = { ...next[existing], ...job }
  return next.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

const removeJob = (jobs: JobSummary[], jobId: string) =>
  jobs.filter((job) => job.id !== jobId)

const mergeJobSummaries = (
  existing: JobSummary[],
  incoming: JobSummary[],
) => {
  const byId = new Map(existing.filter(job => job.__localOnly || incoming.some(next => next.id === job.id)).map((job) => [job.id, job]))
  incoming.forEach((job) => {
    byId.set(job.id, { ...(byId.get(job.id) || {}), ...job } as JobSummary)
  })
  return [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

const upsertMessage = (messages: JobMessage[] = [], message: JobMessage) => {
  const index = messages.findIndex((entry) => entry.id === message.id)
  if (index < 0) return [...messages, message]
  const next = [...messages]
  next[index] = { ...next[index], ...message }
  return next
}

const maybePersist = (job: Job | null) => {
  if (!job) return
  saveLocalJobSnapshot(job)
}

const mergeJobPatch = (job: Job, patch: Partial<Job>): Job => ({
  ...job,
  ...patch,
  result: patch.result ? { ...(job.result || {}), ...patch.result } : job.result,
})

const syncSelectedModule = (state: AppState, job: Job | null): string | null => {
  if (!job) return null
  const modules = collectSelectableModules(job)
  if (state.selectedModuleId && modules.some((module) => module.id === state.selectedModuleId)) {
    return state.selectedModuleId
  }
  return null
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'runtime/loaded':
      return JSON.stringify(state.runtime) === JSON.stringify(action.runtime)
        ? state : { ...state, runtime: action.runtime }
    case 'jobs/loaded': {
      const visible = action.jobs.find(job => job.id === state.currentJobId)
      const current = state.currentJob && visible ? { ...state.currentJob, accessMode: visible.accessMode, capabilities: visible.capabilities, isShowcase: visible.isShowcase } : null
      return { ...state, loading: false, jobs: action.jobs, currentJob: current, currentJobId: current?.id ?? null, ...(current ? {} : { agentEvents: [], chatOpen: false }) }
    }
    case 'jobs/refreshed':
      const refreshedCurrent = state.currentJob
        ? action.jobs.find((job) => job.id === state.currentJob?.id)
        : null
      return {
        ...state,
        currentJob: state.currentJob && refreshedCurrent
          ? ({
              ...state.currentJob,
              ...refreshedCurrent,
              result: state.currentJob.result,
              messages: state.currentJob.messages,
              logs: state.currentJob.logs,
              __summary: state.currentJob.__summary,
            } as Job)
          : state.currentJob?.__localOnly ? state.currentJob : null,
        currentJobId: refreshedCurrent?.id ?? (state.currentJob?.__localOnly ? state.currentJob.id : null),
        jobs: mergeJobSummaries(state.jobs, action.jobs),
      }
    case 'job/selected':
      return {
        ...state,
        agentEvents: [],
        chatFilterModuleId: null,
        currentJob: action.job,
        currentJobId: action.jobId,
        selectedModuleId: syncSelectedModule(state, action.job),
      }
    case 'job/init': {
      maybePersist(action.job)
      if (state.currentJobId && state.currentJobId !== action.job.id) {
        return {
          ...state,
          jobs: upsertJob(state.jobs, action.job),
        }
      }
      return {
        ...state,
        currentJob: action.job,
        currentJobId: action.job.id,
        selectedModuleId: syncSelectedModule(state, action.job),
        jobs: upsertJob(state.jobs, action.job),
      }
    }
    case 'job/updated': {
      const current =
        state.currentJob?.id === action.jobId
          ? {
              ...mergeJobPatch(state.currentJob, action.data),
              updatedAt: action.timestamp || Date.now(),
            }
          : state.currentJob
      if (current?.id === action.jobId) maybePersist(current)
      return {
        ...state,
        currentJob: current,
        selectedModuleId: current?.id === action.jobId ? syncSelectedModule(state, current) : state.selectedModuleId,
        jobs: state.jobs.map((job) =>
          job.id === action.jobId
            ? ({
                ...mergeJobPatch(job, action.data),
                updatedAt: action.timestamp || Date.now(),
              } as JobSummary)
            : job,
        ),
      }
    }
    case 'message/upserted': {
      if (!state.currentJob) return state
      const current = {
        ...state.currentJob,
        messages: upsertMessage(state.currentJob.messages, action.message),
        updatedAt: action.timestamp || Date.now(),
      }
      maybePersist(current)
      return {
        ...state,
        currentJob: current,
        jobs: upsertJob(state.jobs, current),
      }
    }
    case 'agent/event':
      return { ...state, agentEvents: [...state.agentEvents.slice(-200), action.event] }
    case 'pipeline/completed': {
      const patch: Partial<Job> = { status: 'completed' }
      return appReducer(state, {
        type: 'job/updated',
        data: patch,
        jobId: action.jobId,
        timestamp: action.timestamp,
      })
    }
    case 'pipeline/failed':
      return appReducer(state, {
        type: 'job/updated',
        data: { status: 'failed', error: action.message },
        jobId: action.jobId,
        timestamp: action.timestamp,
      })
    case 'job/deleted': {
      const isCurrent = state.currentJobId === action.jobId
      return {
        ...state,
        agentEvents: isCurrent ? [] : state.agentEvents,
        currentJob: isCurrent ? null : state.currentJob,
        currentJobId: isCurrent ? null : state.currentJobId,
        jobs: removeJob(state.jobs, action.jobId),
      }
    }
    case 'module/select':
      return { ...state, selectedModuleId: action.moduleId }
    case 'chat/filter':
      return { ...state, chatFilterModuleId: action.moduleId }
    case 'chat/toggle':
      return { ...state, chatOpen: action.open ?? !state.chatOpen }
    case 'upload/open':
      return { ...state, uploadDialogOpen: action.open }
    case 'result/view-mode':
      return { ...state, resultViewMode: action.value }
    case 'result/compare-position':
      return { ...state, resultComparePosition: Math.min(100, Math.max(0, action.value)) }
    case 'result/preview-width':
      return { ...state, resultPreviewWidth: Math.min(960, Math.max(375, action.value)) }
    case 'error/set':
      return { ...state, error: action.error }
    default:
      return state
  }
}
