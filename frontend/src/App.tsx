import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { loadJob, loadJobs, startJob, deleteJob } from './api/jobs'
import { endAdminSession } from './api/admin'
import type { JobEvent } from './types/events'
import {
  hasPrimaryResults,
  setRuntimeArtifactRoot,
} from './utils/artifacts'
import { STORAGE_KEYS, readStringStorage, writeStringStorage } from './utils/storage'
import {
  getLocalClientId,
  getLocalJobIds,
  getLocalJobSnapshot,
  isJobOwnedByCurrentClient,
  markJobOwnedByCurrentClient,
  removeLocalJobId,
  reviveLocalJobSnapshot,
  saveServerJobsToLocal,
  setLocalJobStorageEnabled,
} from './utils/local-job'
import { appReducer } from './state/app-reducer'
import { initialAppState } from './state/app-state'
import { useRuntimeInfo } from './hooks/useRuntimeInfo'
import { useJobEvents } from './hooks/useJobEvents'
import { useArtifactCache } from './hooks/useArtifactCache'
import { AppShell } from './components/app-shell/AppShell'
import { Sidebar } from './components/sidebar/Sidebar'
import { Toolbar } from './components/toolbar/Toolbar'
import { WorkflowPanel } from './components/workflow/WorkflowPanel'
import { RunningWorkspace } from './components/workflow/RunningWorkspace'
import { ResultPanel } from './components/result/ResultPanel'
import { ChatDrawer } from './components/chat/ChatDrawer'
import { UploadDialog } from './components/upload/UploadDialog'
import { Lightbox } from './components/common/Lightbox'
import { artifactCacheKeyForJob, type ArtifactCacheMeta } from './utils/artifact-cache'
import type { Job, JobMessage } from './types/job'
import './styles/global.css'
import './styles/layout.css'
import './styles/sidebar.css'
import './styles/upload.css'
import './styles/workflow.css'
import './styles/chat.css'

const getUrlJobId = () => new URLSearchParams(window.location.search).get('job')

const updateUrlJob = (jobId: string | null) => {
  const url = new URL(window.location.href)
  if (jobId) url.searchParams.set('job', jobId)
  else url.searchParams.delete('job')
  window.history.replaceState(null, '', url)
}

const defaultSteps = {
  agent: { status: 'pending' as const },
  verify: { status: 'pending' as const },
}

const isLiveJobStatus = (status: unknown) => status === 'running' || status === 'queued'

const jobLivePreviewVersion = (job: Job | null | undefined) => {
  const value = Number(job?.result?.livePreviewVersion ?? job?.result?.livePreviewUpdatedAt ?? 0)
  return Number.isFinite(value) ? value : 0
}

const shouldDeferSummaryPreview = (job: Job | null | undefined) =>
  Boolean(job?.__summary && isLiveJobStatus(job.status) && job.result?.livePreviewEntryPath)

const withoutLivePreview = (job: Job): Job => {
  const {
    livePreviewEntryPath: _livePreviewEntryPath,
    livePreviewUpdatedAt: _livePreviewUpdatedAt,
    livePreviewVersion: _livePreviewVersion,
    ...result
  } = job.result || {}
  return { ...job, result }
}

const withoutLivePreviewFromSummary = (job: Job): Job =>
  shouldDeferSummaryPreview(job) ? withoutLivePreview(job) : job

const immediateJobForSelection = (job: Job): Job =>
  isLiveJobStatus(job.status) && job.result?.livePreviewEntryPath
    ? withoutLivePreview(job)
    : withoutLivePreviewFromSummary(job)

const mergeJobIfNewerPreview = (current: Job | null, incoming: Job) => {
  const nextIncoming = current?.id === incoming.id
    ? {
        ...incoming,
        accessMode: incoming.accessMode ?? current.accessMode,
        isShowcase: incoming.isShowcase ?? current.isShowcase,
        capabilities: incoming.capabilities ?? current.capabilities,
      }
    : incoming
  if (current?.id !== incoming.id || !isLiveJobStatus(current.status) || !isLiveJobStatus(incoming.status)) {
    return nextIncoming
  }
  const currentPreviewVersion = jobLivePreviewVersion(current)
  const incomingPreviewVersion = jobLivePreviewVersion(incoming)
  if (currentPreviewVersion > incomingPreviewVersion) {
    return {
      ...nextIncoming,
      result: {
        ...(nextIncoming.result || {}),
        livePreviewEntryPath: current.result?.livePreviewEntryPath,
        livePreviewUpdatedAt: current.result?.livePreviewUpdatedAt,
        livePreviewVersion: current.result?.livePreviewVersion,
      },
    }
  }
  return nextIncoming
}

const sanitizeJobUpdateForPreview = (current: Job | null, data: Partial<Job> = {}) => {
  const result = data.result
  const hasPreviewPatch = Boolean(
    result &&
      ('livePreviewEntryPath' in result ||
        'livePreviewUpdatedAt' in result ||
        'livePreviewVersion' in result),
  )
  if (!current || !hasPreviewPatch || !isLiveJobStatus(current.status)) return data
  const currentPreviewVersion = jobLivePreviewVersion(current)
  const incomingPreviewVersion = Number(result?.livePreviewVersion ?? result?.livePreviewUpdatedAt ?? 0)
  if (!Number.isFinite(incomingPreviewVersion) || incomingPreviewVersion >= currentPreviewVersion) return data
  return {
    ...data,
    result: {
      ...(result || {}),
      livePreviewEntryPath: current.result?.livePreviewEntryPath,
      livePreviewUpdatedAt: current.result?.livePreviewUpdatedAt,
      livePreviewVersion: current.result?.livePreviewVersion,
    },
  }
}

export default function App({ initialError }: { initialError?: string }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [loadingJobId, setLoadingJobId] = useState<string | null>(null)
  const currentJobRef = useRef(state.currentJob)
  const currentJobIdRef = useRef(state.currentJobId)
  const autoCacheKeysRef = useRef<Map<string, string>>(new Map())
  const ownedJobIdsRef = useRef<Set<string>>(new Set())
  const jobDetailsRef = useRef<Map<string, Job>>(new Map())

  useEffect(() => {
    if (initialError) dispatch({ type: 'error/set', error: initialError })
  }, [initialError])

  useEffect(() => {
    currentJobRef.current = state.currentJob
    if (state.currentJob?.id && !state.currentJob.__summary) {
      jobDetailsRef.current.set(state.currentJob.id, state.currentJob)
    }
  }, [state.currentJob])

  useEffect(() => {
    currentJobIdRef.current = state.currentJobId
  }, [state.currentJobId])

  const handleJobCached = useCallback((job: NonNullable<typeof state.currentJob>, meta: ArtifactCacheMeta) => {
    const localOwnerId = job.localOwnerId || (ownedJobIdsRef.current.has(job.id) ? getLocalClientId() : undefined)
    const currentJob = currentJobRef.current?.id === job.id
      ? currentJobRef.current
      : job
    const resultPatch: Job['result'] = {
      localArtifactCacheAt: meta.cachedAt,
      localArtifactCacheByteSize: meta.byteSize,
      localArtifactCacheError: meta.error,
      localArtifactCacheFileCount: meta.fileCount,
      localArtifactCacheKey: meta.cacheKey,
      localArtifactCachePaths: meta.paths,
      localArtifactCacheStatus: meta.status,
    }
    if (!currentJob.result?.compareEntryPath && meta.compareEntryPath) resultPatch.compareEntryPath = meta.compareEntryPath
    if (!currentJob.result?.renderEntryPath && meta.renderEntryPath) resultPatch.renderEntryPath = meta.renderEntryPath
    if (!currentJob.result?.sourceEntryPath && meta.sourceEntryPath) resultPatch.sourceEntryPath = meta.sourceEntryPath
    const currentUpdatedAt = currentJobRef.current?.id === job.id
      ? currentJobRef.current.updatedAt
      : job.updatedAt
    dispatch({
      type: 'job/updated',
      data: {
        ...(localOwnerId ? { localOwnerId } : {}),
        result: resultPatch,
      },
      jobId: job.id,
      timestamp: currentUpdatedAt || Date.now(),
    })
  }, [])
  const artifactCache = useArtifactCache(handleJobCached)

  const markGeneratedJob = useCallback((job: Job) => {
    ownedJobIdsRef.current.add(job.id)
    const localOwnerId = markJobOwnedByCurrentClient(job.id) || getLocalClientId()
    return { ...job, localOwnerId }
  }, [])

  const restoreGeneratedJobOwner = useCallback((job: Job) => {
    if (isJobOwnedByCurrentClient(job) || !ownedJobIdsRef.current.has(job.id)) return job
    return { ...job, localOwnerId: getLocalClientId() }
  }, [])

  useEffect(() => {
    const job = state.currentJob
    if (!job?.id || job.__localOnly) return
    if (job.accessMode !== 'owner') return
    if (!isJobOwnedByCurrentClient(job) && !ownedJobIdsRef.current.has(job.id)) return
    if (!hasPrimaryResults(job)) return
    const cacheKey = artifactCacheKeyForJob(job)
    const localCacheKey = typeof job.result?.localArtifactCacheKey === 'string' ? job.result.localArtifactCacheKey : ''
    if (
      (job.result?.localArtifactCacheStatus === 'cached' || job.result?.localArtifactCacheStatus === 'caching') &&
      localCacheKey === cacheKey
    ) return
    if (autoCacheKeysRef.current.get(job.id) === cacheKey) return
    autoCacheKeysRef.current.set(job.id, cacheKey)
    void artifactCache.cacheJobArtifacts(job)
  }, [artifactCache, state.currentJob])

  const runtimeLoaded = useCallback((runtime: NonNullable<typeof state.runtime>) => {
    setRuntimeArtifactRoot(runtime.artifactRoot)
    setLocalJobStorageEnabled(Boolean(runtime.enableJobLocalStorage))
    dispatch({ type: 'runtime/loaded', runtime })
  }, [])
  const setError = useCallback((error: string | null) => dispatch({ type: 'error/set', error }), [])
  useRuntimeInfo(runtimeLoaded, setError)

  useEffect(() => {
    if (!state.runtime) return undefined
    let cancelled = false
    const enableLocalJobStorage = Boolean(state.runtime.enableJobLocalStorage)
    loadJobs()
      .then(async (jobs) => {
        if (cancelled) return
        const restoredJobs = enableLocalJobStorage
          ? getLocalJobIds()
              .filter((id) => !jobs.some((job) => job.id === id))
              .flatMap((id) => {
                const snapshot = getLocalJobSnapshot(id)
                const restored = snapshot ? reviveLocalJobSnapshot(snapshot, 'server-reset') : null
                return restored ? [restored] : []
              })
          : []
        const mergedJobs = [...jobs, ...restoredJobs]
        for (const id of jobDetailsRef.current.keys()) if (!mergedJobs.some(job => job.id === id)) jobDetailsRef.current.delete(id)
        if (currentJobIdRef.current && !mergedJobs.some(job => job.id === currentJobIdRef.current)) {
          currentJobIdRef.current = null
          currentJobRef.current = null
          setLightboxSrc(null)
          updateUrlJob(null)
        }
        saveServerJobsToLocal(mergedJobs)
        dispatch({ type: 'jobs/loaded', jobs: mergedJobs })
        const targetId = getUrlJobId() || mergedJobs[0]?.id || null
        if (targetId && !currentJobIdRef.current) {
          setLoadingJobId(targetId)
          try {
            const restored = restoredJobs.find((job) => job.id === targetId)
            const job = restored || await loadJob(targetId)
            if (!cancelled && !currentJobIdRef.current) {
              currentJobIdRef.current = job.id
              currentJobRef.current = job
              dispatch({ type: 'job/selected', job, jobId: job.id })
              updateUrlJob(job.id)
            }
          } catch {
            const snapshot = enableLocalJobStorage ? getLocalJobSnapshot(targetId) : null
            const restored = snapshot ? reviveLocalJobSnapshot(snapshot, 'server-reset') : null
            if (!cancelled && !currentJobIdRef.current) {
              if (restored) {
                currentJobIdRef.current = restored.id
                currentJobRef.current = restored
                dispatch({ type: 'job/selected', job: restored, jobId: restored.id })
              } else {
                dispatch({ type: 'job/selected', job: null, jobId: null })
              }
            }
          } finally {
            if (!cancelled) setLoadingJobId((current) => current === targetId ? null : current)
          }
        }
      })
      .catch((error) => setError(error instanceof Error ? error.message : String(error)))
    return () => {
      cancelled = true
    }
  }, [setError, state.runtime])

  const hasLiveJobSummaries = state.jobs.some((job) => job.status === 'running' || job.status === 'queued')

  useEffect(() => {
    if (!state.runtime) return undefined
    if (!hasLiveJobSummaries) return undefined
    let cancelled = false
    const controller = new AbortController()
    let timer: number | undefined
    const refreshJobs = async () => {
      try {
        const jobs = await loadJobs(controller.signal)
        if (!cancelled) dispatch({ type: 'jobs/refreshed', jobs })
      } catch { /* Retry on the next poll. */ }
      finally {
        if (!cancelled) timer = window.setTimeout(refreshJobs, 2000)
      }
    }
    timer = window.setTimeout(refreshJobs, 2000)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [hasLiveJobSummaries, state.runtime])

  const handleJobEvent = useCallback((event: JobEvent) => {
    const eventJobId = event.type === 'init' ? event.job.id : event.jobId
    const currentJobId = currentJobIdRef.current
    if (!currentJobId || eventJobId !== currentJobId) return
    const currentJob = currentJobRef.current
    switch (event.type) {
      case 'init': {
        const job = mergeJobIfNewerPreview(currentJobRef.current, restoreGeneratedJobOwner(event.job))
        currentJobIdRef.current = job.id
        currentJobRef.current = job
        dispatch({ type: 'job/init', job })
        break
      }
      case 'job:updated':
        if (event.job) {
          const job = mergeJobIfNewerPreview(currentJobRef.current, restoreGeneratedJobOwner(event.job))
          currentJobRef.current = job
          dispatch({
            type: 'job/updated',
            data: job,
            jobId: job.id,
            timestamp: event.timestamp,
          })
        } else {
          const data = event.data || event.patch
          if (!data) break
          dispatch({
            type: 'job/updated',
            data: sanitizeJobUpdateForPreview(currentJobRef.current, data),
            jobId: event.jobId,
            timestamp: event.timestamp,
          })
        }
        break
      case 'job:deleted':
        dispatch({ type: 'job/deleted', jobId: event.jobId })
        break
      case 'message':
        dispatch({ type: 'message/upserted', message: event.message, timestamp: event.timestamp })
        break
      case 'agent:event':
        dispatch({ type: 'agent/event', event: { ...event.event, timestamp: event.timestamp } })
        break
      case 'pipeline:complete':
        dispatch({ type: 'pipeline/completed', jobId: event.jobId, timestamp: event.timestamp })
        break
      case 'pipeline:error':
        dispatch({ type: 'pipeline/failed', message: event.message, jobId: event.jobId, timestamp: event.timestamp })
        break
      case 'step:start':
        dispatch({
          type: 'job/updated',
          data: {
            activeStep: event.step,
            status: 'running',
            steps: {
              ...defaultSteps,
              ...(currentJob?.steps || {}),
              [event.step]: { ...(currentJob?.steps?.[event.step] || {}), status: 'running' },
            },
          },
          jobId: event.jobId,
          timestamp: event.timestamp,
        })
        break
      case 'step:complete':
        dispatch({
          type: 'job/updated',
          data: {
            activeStep: null,
            result: { ...(currentJob?.result || {}), ...(event.data || {}) },
            steps: {
              ...defaultSteps,
              ...(currentJob?.steps || {}),
              [event.step]: { ...(currentJob?.steps?.[event.step] || {}), status: 'completed' },
            },
          },
          jobId: event.jobId,
          timestamp: event.timestamp,
        })
        break
      case 'step:error':
        dispatch({
          type: 'job/updated',
          data: {
            activeStep: null,
            steps: {
              ...defaultSteps,
              ...(currentJob?.steps || {}),
              [event.step]: { ...(currentJob?.steps?.[event.step] || {}), status: 'failed', error: event.message },
            },
          },
          jobId: event.jobId,
          timestamp: event.timestamp,
        })
        break
      default:
        break
    }
  }, [restoreGeneratedJobOwner])

  useJobEvents(state.currentJobId, handleJobEvent)

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultViewMode, state.resultViewMode)
  }, [state.resultViewMode])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultComparePosition, String(state.resultComparePosition))
  }, [state.resultComparePosition])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultPreviewWidth, String(state.resultPreviewWidth))
  }, [state.resultPreviewWidth])

  const selectJob = (id: string) => {
    if (!id || id === currentJobIdRef.current) return
    setLoadingJobId(id)
    setError(null)
    const previousJobId = currentJobIdRef.current
    const previousJob = currentJobRef.current
    currentJobIdRef.current = id
    const snapshot = state.runtime?.enableJobLocalStorage ? getLocalJobSnapshot(id) : null
    const localOnly = state.jobs.find((job) => job.id === id)?.__localOnly
    if (localOnly && snapshot) {
      const restored = reviveLocalJobSnapshot(snapshot, 'server-reset')!
      jobDetailsRef.current.set(restored.id, restored)
      currentJobRef.current = restored
      currentJobIdRef.current = restored.id
      dispatch({ type: 'job/selected', job: restored, jobId: restored.id })
      updateUrlJob(restored.id)
      setLoadingJobId(null)
      return
    }

    const cached = jobDetailsRef.current.get(id)
    if (cached) {
      const immediateJob = immediateJobForSelection(cached)
      currentJobRef.current = immediateJob
      dispatch({ type: 'job/selected', job: immediateJob, jobId: id })
      updateUrlJob(id)
    } else {
      const summary = state.jobs.find((job) => job.id === id) || null
      const immediateJob = summary ? immediateJobForSelection(summary) : null
      currentJobRef.current = immediateJob
      dispatch({ type: 'job/selected', job: immediateJob, jobId: id })
      updateUrlJob(id)
    }

    void loadJob(id)
      .then((loaded) => {
        if (currentJobIdRef.current !== id) return
        const job = mergeJobIfNewerPreview(currentJobRef.current, restoreGeneratedJobOwner(loaded))
        jobDetailsRef.current.set(job.id, job)
        currentJobRef.current = job
        dispatch({ type: 'job/selected', job, jobId: job.id })
        updateUrlJob(job.id)
      })
      .catch((error) => {
        if (currentJobIdRef.current !== id) return
        const restored = snapshot ? reviveLocalJobSnapshot(snapshot, 'server-reset') : null
        if (restored) {
          jobDetailsRef.current.set(restored.id, restored)
          currentJobRef.current = restored
          currentJobIdRef.current = restored.id
          dispatch({ type: 'job/selected', job: restored, jobId: restored.id })
          updateUrlJob(restored.id)
          return
        }
        if (!cached) {
          currentJobIdRef.current = previousJobId
          currentJobRef.current = previousJob
          dispatch({ type: 'job/selected', job: previousJob, jobId: previousJobId })
          updateUrlJob(previousJobId)
        }
        setError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setLoadingJobId((current) => current === id ? null : current)
      })
  }

  const startCurrentJob = async () => {
    if (!state.currentJob?.id) return
    markGeneratedJob(state.currentJob)
    try {
      await startJob(state.currentJob.id)
      const job = restoreGeneratedJobOwner(await loadJob(state.currentJob.id))
      dispatch({ type: 'job/selected', job, jobId: job.id })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteCurrentJob = async () => {
    if (!state.currentJob?.id) return
    if (!window.confirm(`确定删除 job ${state.currentJob.id} 吗？`)) return
    const deletedJobId = state.currentJob.id
    try {
      if (!state.currentJob.__localOnly) await deleteJob(state.currentJob.id)
      removeLocalJobId(state.currentJob.id)
      jobDetailsRef.current.delete(deletedJobId)
      dispatch({ type: 'job/deleted', jobId: deletedJobId })
      updateUrlJob(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  const exitAdminMode = async () => {
    try {
      await endAdminSession()
      window.location.reload()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleTheme = () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
    if (current === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
    writeStringStorage(STORAGE_KEYS.theme, current)
  }

  useEffect(() => {
    const theme = readStringStorage(STORAGE_KEYS.theme, 'light')
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
  }, [])

  const selectModule = useCallback((moduleId: string | null) => {
    dispatch({ type: 'module/select', moduleId })
    dispatch({ type: 'chat/filter', moduleId })
  }, [])
  const upsertQueuedMessage = useCallback((message: JobMessage) => {
    dispatch({ type: 'message/upserted', message, timestamp: Date.now() })
  }, [])

  const cacheStatus = artifactCache.statusFor(state.currentJob)
  const showcaseReadOnly = !state.currentJob?.capabilities?.canWrite
  const chatDisabled = Boolean(state.runtime?.jobChatDisabled || showcaseReadOnly)
  const showResults = hasPrimaryResults(state.currentJob)
  const showRunningWorkspace = Boolean(
    state.currentJob &&
      !showResults &&
      state.currentJob.status === 'running',
  )

  const main = (
    <>
      <Toolbar
        chatDisabled={chatDisabled}
        chatOpen={state.chatOpen}
        deleteDisabled={Boolean(
          state.runtime?.jobDeleteDisabled || !state.currentJob?.capabilities?.canDelete,
        )}
        onDelete={deleteCurrentJob}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        onToggleChat={() => dispatch({ type: 'chat/toggle' })}
        onToggleTheme={toggleTheme}
        job={state.currentJob}
        showChatToggle={!showRunningWorkspace}
        sidebarCollapsed={sidebarCollapsed}
      />
      <div className="content-area">
        {loadingJobId ? (
          <div className="job-loading-overlay" aria-live="polite" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            <strong>正在加载任务</strong>
            <span>{state.jobs.find((job) => job.id === loadingJobId)?.designName || loadingJobId}</span>
          </div>
        ) : null}
        {state.currentJob && state.currentJob.status === 'draft' && !showcaseReadOnly ? (
          <div className="workflow-panel visible">
            <button className="upload-dialog-submit" onClick={startCurrentJob} type="button">开始生成</button>
          </div>
        ) : null}
        {showRunningWorkspace ? (
          <RunningWorkspace
            agentEvents={state.agentEvents}
            chatDisabled={chatDisabled}
            chatFilterModuleId={state.chatFilterModuleId}
            onFilterModule={(moduleId) => dispatch({ type: 'chat/filter', moduleId })}
            onMessageQueued={upsertQueuedMessage}
            onSelectModule={selectModule}
            selectedModuleId={state.selectedModuleId}
            job={state.currentJob}
          />
        ) : (
          <WorkflowPanel job={state.currentJob} visible={!showResults} />
        )}
        <ResultPanel
          cacheBusy={cacheStatus.busy}
          cacheError={cacheStatus.error}
          cacheMeta={cacheStatus.meta}
          chatOpen={state.chatOpen}
          comparePosition={state.resultComparePosition}
          onComparePositionChange={(value) => dispatch({ type: 'result/compare-position', value })}
          onDownloadZip={(kind) => artifactCache.downloadJobZip(state.currentJob, kind)}
          onOpenArtifact={(kind) => artifactCache.openJobArtifact(state.currentJob, kind)}
          onOpenLightbox={setLightboxSrc}
          onPreviewWidthChange={(value) => dispatch({ type: 'result/preview-width', value })}
          onSelectModule={selectModule}
          onViewModeChange={(value) => dispatch({ type: 'result/view-mode', value })}
          previewWidth={state.resultPreviewWidth}
          selectedModuleId={state.selectedModuleId}
          job={state.currentJob}
          viewMode={state.resultViewMode}
        />
      </div>
    </>
  )

  return (
    <>
      <AppShell
        chat={
          showRunningWorkspace ? null : (
            <ChatDrawer
              agentEvents={state.agentEvents}
              chatFilterModuleId={state.chatFilterModuleId}
              disabled={chatDisabled}
              onClose={() => dispatch({ type: 'chat/toggle', open: false })}
              onFilterModule={(moduleId) => dispatch({ type: 'chat/filter', moduleId })}
              onMessageQueued={upsertQueuedMessage}
              onSelectModule={selectModule}
              open={state.chatOpen}
              selectedModuleId={state.selectedModuleId}
              job={state.currentJob}
            />
          )
        }
        main={main}
        sidebar={
          <Sidebar
            adminMode={Boolean(state.runtime?.adminMode)}
            quotaEnabled={state.runtime?.quotaEnabled !== false}
            initialized={Boolean(state.runtime?.initialized)}
            currentJobId={state.currentJobId}
            onCollapse={() => setSidebarCollapsed(true)}
            onOpenUpload={() => {
              setUploadFile(null)
              dispatch({ type: 'upload/open', open: true })
            }}
            onExitAdmin={exitAdminMode}
            onUploadFile={(file) => {
              setUploadFile(file)
              dispatch({ type: 'upload/open', open: true })
            }}
            onSelectJob={selectJob}
            jobs={state.jobs}
            uploadQuota={state.runtime?.uploadQuota || null}
          />
        }
        sidebarCollapsed={sidebarCollapsed}
      />
      <UploadDialog
        adminMode={Boolean(state.runtime?.adminMode)}
        quotaEnabled={state.runtime?.quotaEnabled !== false}
        allowUserShowcase={Boolean(state.runtime?.allowUserShowcase)}
        initialFile={uploadFile}
        maxSvgUploadBytes={state.runtime?.maxSvgUploadBytes || 50 * 1024 * 1024}
        modelOptions={state.runtime?.modelOptions || []}
        outputFormats={state.runtime?.outputFormats}
        onClose={() => dispatch({ type: 'upload/open', open: false })}
        onQuotaChanged={(uploadQuota) => {
          if (state.runtime) runtimeLoaded({ ...state.runtime, uploadQuota })
        }}
        onUploaded={(response) => {
          if (state.runtime && response.quota) {
            runtimeLoaded({ ...state.runtime, uploadQuota: response.quota })
          }
          const uploaded = (response.jobs || (response.job ? [response.job] : [])).map((job) => {
            return markGeneratedJob(job)
          })
          dispatch({ type: 'jobs/loaded', jobs: [...uploaded, ...state.jobs] })
          const first = uploaded[0]
          if (first) {
            dispatch({ type: 'job/selected', job: first, jobId: first.id })
            updateUrlJob(first.id)
          }
          void Promise.all(
            uploaded
              .filter((job) => job.status !== 'queued' && job.status !== 'running')
              .map(async (job) => {
                await startJob(job.id)
                if (job.id === first?.id) {
                  const fresh = restoreGeneratedJobOwner(await loadJob(job.id))
                  dispatch({ type: 'job/selected', job: fresh, jobId: fresh.id })
                }
              }),
          ).catch((error) => setError(error instanceof Error ? error.message : String(error)))
        }}
        open={state.uploadDialogOpen}
        uploadQuota={state.runtime?.uploadQuota || null}
      />
      <Lightbox onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
    </>
  )
}
