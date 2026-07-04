import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { loadSession, loadSessions, startSession, deleteSession } from './api/sessions'
import type { SessionEvent } from './types/events'
import {
  hasPrimaryResults,
  setRuntimeWorkspaceRoot,
} from './utils/artifacts'
import { STORAGE_KEYS, readStringStorage, writeStringStorage } from './utils/storage'
import { getRunSettingsPayload } from './utils/settings'
import {
  getLocalClientId,
  getLocalSessionIds,
  getLocalSessionSnapshot,
  isSessionOwnedByCurrentClient,
  markSessionOwnedByCurrentClient,
  removeLocalSessionId,
  reviveLocalSessionSnapshot,
  saveServerSessionsToLocal,
  setLocalSessionStorageEnabled,
} from './utils/local-session'
import { appReducer } from './state/app-reducer'
import { initialAppState } from './state/app-state'
import { useRuntimeInfo } from './hooks/useRuntimeInfo'
import { useSessionEvents } from './hooks/useSessionEvents'
import { useArtifactCache } from './hooks/useArtifactCache'
import { AppShell } from './components/app-shell/AppShell'
import { Sidebar } from './components/sidebar/Sidebar'
import { Toolbar } from './components/toolbar/Toolbar'
import { WorkflowPanel } from './components/workflow/WorkflowPanel'
import { RunningWorkspace } from './components/workflow/RunningWorkspace'
import { ResultPanel } from './components/result/ResultPanel'
import { ChatDrawer } from './components/chat/ChatDrawer'
import { UploadDialog } from './components/upload/UploadDialog'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { Lightbox } from './components/common/Lightbox'
import { artifactCacheKeyForSession, type ArtifactCacheMeta } from './utils/artifact-cache'
import type { Session, SessionMessage } from './types/session'
import './styles/global.css'
import './styles/layout.css'
import './styles/sidebar.css'
import './styles/upload.css'
import './styles/workflow.css'
import './styles/result.css'
import './styles/chat.css'
import './styles/settings.css'

const getUrlSessionId = () => new URLSearchParams(window.location.search).get('session')

const updateUrlSession = (sessionId: string | null) => {
  const url = new URL(window.location.href)
  if (sessionId) url.searchParams.set('session', sessionId)
  else url.searchParams.delete('session')
  window.history.replaceState(null, '', url)
}

const defaultSteps = {
  agent: { status: 'pending' as const },
  verify: { status: 'pending' as const },
}

const isLiveSessionStatus = (status: unknown) => status === 'running' || status === 'queued'

const sessionLivePreviewVersion = (session: Session | null | undefined) => {
  const value = Number(session?.result?.livePreviewVersion ?? session?.result?.livePreviewUpdatedAt ?? 0)
  return Number.isFinite(value) ? value : 0
}

const shouldDeferSummaryPreview = (session: Session | null | undefined) =>
  Boolean(session?.__summary && isLiveSessionStatus(session.status) && session.result?.livePreviewEntryPath)

const withoutLivePreview = (session: Session): Session => {
  const {
    livePreviewEntryPath: _livePreviewEntryPath,
    livePreviewUpdatedAt: _livePreviewUpdatedAt,
    livePreviewVersion: _livePreviewVersion,
    ...result
  } = session.result || {}
  return { ...session, result }
}

const withoutLivePreviewFromSummary = (session: Session): Session =>
  shouldDeferSummaryPreview(session) ? withoutLivePreview(session) : session

const immediateSessionForSelection = (session: Session): Session =>
  isLiveSessionStatus(session.status) && session.result?.livePreviewEntryPath
    ? withoutLivePreview(session)
    : withoutLivePreviewFromSummary(session)

const mergeSessionIfNewerPreview = (current: Session | null, incoming: Session) => {
  if (current?.id !== incoming.id || !isLiveSessionStatus(current.status) || !isLiveSessionStatus(incoming.status)) {
    return incoming
  }
  const currentPreviewVersion = sessionLivePreviewVersion(current)
  const incomingPreviewVersion = sessionLivePreviewVersion(incoming)
  if (currentPreviewVersion > incomingPreviewVersion) {
    return {
      ...incoming,
      result: {
        ...(incoming.result || {}),
        livePreviewEntryPath: current.result?.livePreviewEntryPath,
        livePreviewUpdatedAt: current.result?.livePreviewUpdatedAt,
        livePreviewVersion: current.result?.livePreviewVersion,
      },
    }
  }
  return incoming
}

const sanitizeSessionUpdateForPreview = (current: Session | null, data: Partial<Session>) => {
  const result = data.result
  const hasPreviewPatch = Boolean(
    result &&
      ('livePreviewEntryPath' in result ||
        'livePreviewUpdatedAt' in result ||
        'livePreviewVersion' in result),
  )
  if (!current || !hasPreviewPatch || !isLiveSessionStatus(current.status)) return data
  const currentPreviewVersion = sessionLivePreviewVersion(current)
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

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const currentSessionRef = useRef(state.currentSession)
  const currentSessionIdRef = useRef(state.currentSessionId)
  const autoCacheKeysRef = useRef<Map<string, string>>(new Map())
  const ownedSessionIdsRef = useRef<Set<string>>(new Set())
  const sessionDetailsRef = useRef<Map<string, Session>>(new Map())

  useEffect(() => {
    currentSessionRef.current = state.currentSession
    if (state.currentSession?.id && !state.currentSession.__summary) {
      sessionDetailsRef.current.set(state.currentSession.id, state.currentSession)
    }
  }, [state.currentSession])

  useEffect(() => {
    currentSessionIdRef.current = state.currentSessionId
  }, [state.currentSessionId])

  const handleSessionCached = useCallback((session: NonNullable<typeof state.currentSession>, meta: ArtifactCacheMeta) => {
    const localOwnerId = session.localOwnerId || (ownedSessionIdsRef.current.has(session.id) ? getLocalClientId() : undefined)
    const currentSession = currentSessionRef.current?.id === session.id
      ? currentSessionRef.current
      : session
    const resultPatch: Session['result'] = {
      localArtifactCacheAt: meta.cachedAt,
      localArtifactCacheByteSize: meta.byteSize,
      localArtifactCacheError: meta.error,
      localArtifactCacheFileCount: meta.fileCount,
      localArtifactCacheKey: meta.cacheKey,
      localArtifactCachePaths: meta.paths,
      localArtifactCacheStatus: meta.status,
    }
    if (!currentSession.result?.compareEntryPath && meta.compareEntryPath) resultPatch.compareEntryPath = meta.compareEntryPath
    if (!currentSession.result?.renderEntryPath && meta.renderEntryPath) resultPatch.renderEntryPath = meta.renderEntryPath
    if (!currentSession.result?.sourceEntryPath && meta.sourceEntryPath) resultPatch.sourceEntryPath = meta.sourceEntryPath
    const currentUpdatedAt = currentSessionRef.current?.id === session.id
      ? currentSessionRef.current.updatedAt
      : session.updatedAt
    dispatch({
      type: 'session/updated',
      data: {
        ...(localOwnerId ? { localOwnerId } : {}),
        result: resultPatch,
      },
      sessionId: session.id,
      timestamp: currentUpdatedAt || Date.now(),
    })
  }, [])
  const artifactCache = useArtifactCache(handleSessionCached)

  const markGeneratedSession = useCallback((session: Session) => {
    ownedSessionIdsRef.current.add(session.id)
    const localOwnerId = markSessionOwnedByCurrentClient(session.id) || getLocalClientId()
    return { ...session, localOwnerId }
  }, [])

  const restoreGeneratedSessionOwner = useCallback((session: Session) => {
    if (isSessionOwnedByCurrentClient(session) || !ownedSessionIdsRef.current.has(session.id)) return session
    return { ...session, localOwnerId: getLocalClientId() }
  }, [])

  useEffect(() => {
    const session = state.currentSession
    if (!session?.id || session.__localOnly) return
    if (!isSessionOwnedByCurrentClient(session) && !ownedSessionIdsRef.current.has(session.id)) return
    if (!hasPrimaryResults(session)) return
    const cacheKey = artifactCacheKeyForSession(session)
    const localCacheKey = typeof session.result?.localArtifactCacheKey === 'string' ? session.result.localArtifactCacheKey : ''
    if (
      (session.result?.localArtifactCacheStatus === 'cached' || session.result?.localArtifactCacheStatus === 'caching') &&
      localCacheKey === cacheKey
    ) return
    if (autoCacheKeysRef.current.get(session.id) === cacheKey) return
    autoCacheKeysRef.current.set(session.id, cacheKey)
    void artifactCache.cacheSessionArtifacts(session)
  }, [artifactCache, state.currentSession])

  const runtimeLoaded = useCallback((runtime: NonNullable<typeof state.runtime>) => {
    setRuntimeWorkspaceRoot(runtime.workspaceRoot)
    setLocalSessionStorageEnabled(Boolean(runtime.enableSessionLocalStorage))
    dispatch({ type: 'runtime/loaded', runtime })
  }, [])
  const setError = useCallback((error: string | null) => dispatch({ type: 'error/set', error }), [])
  useRuntimeInfo(runtimeLoaded, setError)

  useEffect(() => {
    if (!state.runtime) return undefined
    let cancelled = false
    const enableLocalSessionStorage = Boolean(state.runtime.enableSessionLocalStorage)
    loadSessions()
      .then(async (sessions) => {
        if (cancelled) return
        const restoredSessions = enableLocalSessionStorage
          ? getLocalSessionIds()
              .filter((id) => !sessions.some((session) => session.id === id))
              .flatMap((id) => {
                const snapshot = getLocalSessionSnapshot(id)
                const restored = snapshot ? reviveLocalSessionSnapshot(snapshot, 'server-reset') : null
                return restored ? [restored] : []
              })
          : []
        const mergedSessions = [...sessions, ...restoredSessions]
        saveServerSessionsToLocal(mergedSessions)
        dispatch({ type: 'sessions/loaded', sessions: mergedSessions })
        const targetId = getUrlSessionId() || mergedSessions[0]?.id || null
        if (targetId && !currentSessionIdRef.current) {
          try {
            const restored = restoredSessions.find((session) => session.id === targetId)
            const session = restored || await loadSession(targetId)
            if (!cancelled && !currentSessionIdRef.current) {
              currentSessionIdRef.current = session.id
              currentSessionRef.current = session
              dispatch({ type: 'session/selected', session, sessionId: session.id })
              updateUrlSession(session.id)
            }
          } catch {
            const snapshot = getLocalSessionSnapshot(targetId)
            const restored = snapshot ? reviveLocalSessionSnapshot(snapshot, 'server-reset') : null
            if (!cancelled && !currentSessionIdRef.current) {
              if (restored) {
                currentSessionIdRef.current = restored.id
                currentSessionRef.current = restored
                dispatch({ type: 'session/selected', session: restored, sessionId: restored.id })
              } else {
                dispatch({ type: 'session/selected', session: null, sessionId: null })
              }
            }
          }
        }
      })
      .catch((error) => setError(error instanceof Error ? error.message : String(error)))
    return () => {
      cancelled = true
    }
  }, [setError, state.runtime])

  const hasLiveSessionSummaries = state.sessions.some((session) => session.status === 'running' || session.status === 'queued')

  useEffect(() => {
    if (!state.runtime) return undefined
    if (!hasLiveSessionSummaries) return undefined
    let cancelled = false
    const refreshSessions = () => {
      loadSessions()
        .then((sessions) => {
          if (!cancelled) dispatch({ type: 'sessions/refreshed', sessions })
        })
        .catch(() => {})
    }
    refreshSessions()
    const timer = window.setInterval(refreshSessions, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [hasLiveSessionSummaries, state.runtime])

  const handleSessionEvent = useCallback((event: SessionEvent) => {
    const eventSessionId = event.type === 'init' ? event.session.id : event.sessionId
    const currentSessionId = currentSessionIdRef.current
    if (currentSessionId && eventSessionId !== currentSessionId) return
    const currentSession = currentSessionRef.current
    switch (event.type) {
      case 'init': {
        const session = mergeSessionIfNewerPreview(currentSessionRef.current, restoreGeneratedSessionOwner(event.session))
        currentSessionIdRef.current = session.id
        currentSessionRef.current = session
        dispatch({ type: 'session/init', session })
        break
      }
      case 'session:updated':
        dispatch({
          type: 'session/updated',
          data: sanitizeSessionUpdateForPreview(currentSessionRef.current, event.data),
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        })
        break
      case 'session:deleted':
        dispatch({ type: 'session/deleted', sessionId: event.sessionId })
        break
      case 'message':
        dispatch({ type: 'message/upserted', message: event.message, timestamp: event.timestamp })
        break
      case 'agent:event':
        dispatch({ type: 'agent/event', event: { ...event.event, timestamp: event.timestamp } })
        break
      case 'pipeline:complete':
        dispatch({ type: 'pipeline/completed', sessionId: event.sessionId, timestamp: event.timestamp })
        break
      case 'pipeline:error':
        dispatch({ type: 'pipeline/failed', message: event.message, sessionId: event.sessionId, timestamp: event.timestamp })
        break
      case 'step:start':
        dispatch({
          type: 'session/updated',
          data: {
            activeStep: event.step,
            status: 'running',
            steps: {
              ...defaultSteps,
              ...(currentSession?.steps || {}),
              [event.step]: { ...(currentSession?.steps?.[event.step] || {}), status: 'running' },
            },
          },
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        })
        break
      case 'step:complete':
        dispatch({
          type: 'session/updated',
          data: {
            activeStep: null,
            result: { ...(currentSession?.result || {}), ...(event.data || {}) },
            steps: {
              ...defaultSteps,
              ...(currentSession?.steps || {}),
              [event.step]: { ...(currentSession?.steps?.[event.step] || {}), status: 'completed' },
            },
          },
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        })
        break
      case 'step:error':
        dispatch({
          type: 'session/updated',
          data: {
            activeStep: null,
            steps: {
              ...defaultSteps,
              ...(currentSession?.steps || {}),
              [event.step]: { ...(currentSession?.steps?.[event.step] || {}), status: 'failed', error: event.message },
            },
          },
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        })
        break
      default:
        break
    }
  }, [restoreGeneratedSessionOwner])

  useSessionEvents(state.currentSessionId, handleSessionEvent)

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultViewMode, state.resultViewMode)
  }, [state.resultViewMode])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultComparePosition, String(state.resultComparePosition))
  }, [state.resultComparePosition])

  useEffect(() => {
    writeStringStorage(STORAGE_KEYS.resultPreviewWidth, String(state.resultPreviewWidth))
  }, [state.resultPreviewWidth])

  const selectSession = (id: string) => {
    if (!id || id === currentSessionIdRef.current) return
    const previousSessionId = currentSessionIdRef.current
    const previousSession = currentSessionRef.current
    currentSessionIdRef.current = id
    const snapshot = getLocalSessionSnapshot(id)
    const localOnly = state.sessions.find((session) => session.id === id)?.__localOnly
    if (localOnly && snapshot) {
      const restored = reviveLocalSessionSnapshot(snapshot, 'server-reset')!
      sessionDetailsRef.current.set(restored.id, restored)
      currentSessionRef.current = restored
      currentSessionIdRef.current = restored.id
      dispatch({ type: 'session/selected', session: restored, sessionId: restored.id })
      updateUrlSession(restored.id)
      return
    }

    const cached = sessionDetailsRef.current.get(id)
    if (cached) {
      const immediateSession = immediateSessionForSelection(cached)
      currentSessionRef.current = immediateSession
      dispatch({ type: 'session/selected', session: immediateSession, sessionId: id })
      updateUrlSession(id)
    } else {
      const summary = state.sessions.find((session) => session.id === id) || null
      const immediateSession = summary ? immediateSessionForSelection(summary) : null
      currentSessionRef.current = immediateSession
      dispatch({ type: 'session/selected', session: immediateSession, sessionId: id })
      updateUrlSession(id)
    }

    void loadSession(id)
      .then((loaded) => {
        if (currentSessionIdRef.current !== id) return
        const session = mergeSessionIfNewerPreview(currentSessionRef.current, restoreGeneratedSessionOwner(loaded))
        sessionDetailsRef.current.set(session.id, session)
        currentSessionRef.current = session
        dispatch({ type: 'session/selected', session, sessionId: session.id })
        updateUrlSession(session.id)
      })
      .catch((error) => {
        if (currentSessionIdRef.current !== id) return
        const restored = snapshot ? reviveLocalSessionSnapshot(snapshot, 'server-reset') : null
        if (restored) {
          sessionDetailsRef.current.set(restored.id, restored)
          currentSessionRef.current = restored
          currentSessionIdRef.current = restored.id
          dispatch({ type: 'session/selected', session: restored, sessionId: restored.id })
          updateUrlSession(restored.id)
          return
        }
        if (!cached) {
          currentSessionIdRef.current = previousSessionId
          currentSessionRef.current = previousSession
          dispatch({ type: 'session/selected', session: previousSession, sessionId: previousSessionId })
          updateUrlSession(previousSessionId)
        }
        setError(error instanceof Error ? error.message : String(error))
      })
  }

  const startCurrentSession = async () => {
    if (!state.currentSession?.id) return
    markGeneratedSession(state.currentSession)
    const settings = getRunSettingsPayload(Boolean(state.runtime?.frontendSettingsEnabled))
    try {
      await startSession(state.currentSession.id, settings)
      const session = restoreGeneratedSessionOwner(await loadSession(state.currentSession.id))
      dispatch({ type: 'session/selected', session, sessionId: session.id })
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteCurrentSession = async () => {
    if (!state.currentSession?.id) return
    if (!window.confirm(`确定删除 session ${state.currentSession.id} 吗？`)) return
    const deletedSessionId = state.currentSession.id
    try {
      if (!state.currentSession.__localOnly) await deleteSession(state.currentSession.id)
      removeLocalSessionId(state.currentSession.id)
      sessionDetailsRef.current.delete(deletedSessionId)
      dispatch({ type: 'session/deleted', sessionId: deletedSessionId })
      updateUrlSession(null)
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
  const upsertQueuedMessage = useCallback((message: SessionMessage) => {
    dispatch({ type: 'message/upserted', message, timestamp: Date.now() })
  }, [])

  const cacheStatus = artifactCache.statusFor(state.currentSession)
  const showResults = hasPrimaryResults(state.currentSession)
  const showRunningWorkspace = Boolean(
    state.currentSession &&
      !showResults &&
      (state.currentSession.status === 'running' || state.currentSession.status === 'queued'),
  )

  const main = (
    <>
      <Toolbar
        chatDisabled={Boolean(state.runtime?.sessionChatDisabled)}
        chatOpen={state.chatOpen}
        deleteDisabled={Boolean(state.runtime?.sessionDeleteDisabled)}
        onDelete={deleteCurrentSession}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        onOpenSettings={() => dispatch({ type: 'settings/open', open: true })}
        onToggleChat={() => dispatch({ type: 'chat/toggle' })}
        onToggleTheme={toggleTheme}
        session={state.currentSession}
        showChatToggle={!showRunningWorkspace}
        sidebarCollapsed={sidebarCollapsed}
        settingsEnabled={Boolean(state.runtime?.frontendSettingsEnabled)}
      />
      <div className="content-area">
        {state.error ? <div className="url-error app-error">{state.error}</div> : null}
        {state.currentSession && state.currentSession.status === 'draft' ? (
          <div className="workflow-panel visible">
            <button className="upload-dialog-submit" onClick={startCurrentSession} type="button">开始生成</button>
          </div>
        ) : null}
        {showRunningWorkspace ? (
          <RunningWorkspace
            agentEvents={state.agentEvents}
            chatDisabled={Boolean(state.runtime?.sessionChatDisabled)}
            chatFilterModuleId={state.chatFilterModuleId}
            onFilterModule={(moduleId) => dispatch({ type: 'chat/filter', moduleId })}
            onMessageQueued={upsertQueuedMessage}
            onSelectModule={selectModule}
            selectedModuleId={state.selectedModuleId}
            session={state.currentSession}
          />
        ) : (
          <WorkflowPanel session={state.currentSession} visible={!showResults} />
        )}
        <ResultPanel
          cacheBusy={cacheStatus.busy}
          cacheError={cacheStatus.error}
          cacheMeta={cacheStatus.meta}
          chatOpen={state.chatOpen}
          comparePosition={state.resultComparePosition}
          onComparePositionChange={(value) => dispatch({ type: 'result/compare-position', value })}
          onDownloadZip={() => artifactCache.downloadSessionZip(state.currentSession)}
          onOpenArtifact={(kind) => artifactCache.openSessionArtifact(state.currentSession, kind)}
          onOpenLightbox={setLightboxSrc}
          onPreviewWidthChange={(value) => dispatch({ type: 'result/preview-width', value })}
          onSelectModule={selectModule}
          onViewModeChange={(value) => dispatch({ type: 'result/view-mode', value })}
          previewWidth={state.resultPreviewWidth}
          selectedModuleId={state.selectedModuleId}
          session={state.currentSession}
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
              disabled={Boolean(state.runtime?.sessionChatDisabled)}
              onClose={() => dispatch({ type: 'chat/toggle', open: false })}
              onFilterModule={(moduleId) => dispatch({ type: 'chat/filter', moduleId })}
              onMessageQueued={upsertQueuedMessage}
              onSelectModule={selectModule}
              open={state.chatOpen}
              selectedModuleId={state.selectedModuleId}
              session={state.currentSession}
            />
          )
        }
        main={main}
        sidebar={
          <Sidebar
            currentSessionId={state.currentSessionId}
            onCollapse={() => setSidebarCollapsed(true)}
            onOpenUpload={() => {
              setUploadFile(null)
              dispatch({ type: 'upload/open', open: true })
            }}
            onUploadFile={(file) => {
              setUploadFile(file)
              dispatch({ type: 'upload/open', open: true })
            }}
            onSelectSession={selectSession}
            sessions={state.sessions}
          />
        }
        sidebarCollapsed={sidebarCollapsed}
      />
      <UploadDialog
        initialFile={uploadFile}
        onClose={() => dispatch({ type: 'upload/open', open: false })}
        onUploaded={(response) => {
          const uploaded = (response.sessions || (response.session ? [response.session] : [])).map((session) => {
            return markGeneratedSession(session)
          })
          dispatch({ type: 'sessions/loaded', sessions: [...uploaded, ...state.sessions] })
          const first = uploaded[0]
          if (first) {
            dispatch({ type: 'session/selected', session: first, sessionId: first.id })
            updateUrlSession(first.id)
          }
          const settings = getRunSettingsPayload(Boolean(state.runtime?.frontendSettingsEnabled))
          void Promise.all(
            uploaded
              .filter((session) => session.status !== 'queued' && session.status !== 'running')
              .map(async (session) => {
                await startSession(session.id, settings)
                if (session.id === first?.id) {
                  const fresh = restoreGeneratedSessionOwner(await loadSession(session.id))
                  dispatch({ type: 'session/selected', session: fresh, sessionId: fresh.id })
                }
              }),
          ).catch((error) => setError(error instanceof Error ? error.message : String(error)))
        }}
        open={state.uploadDialogOpen}
      />
      <SettingsDialog onClose={() => dispatch({ type: 'settings/open', open: false })} open={state.settingsDialogOpen} runtime={state.runtime} />
      <Lightbox onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
    </>
  )
}
