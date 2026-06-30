import type { Session, SessionMessage, SessionSummary } from '../types/session'
import { saveLocalSessionSnapshot } from '../utils/local-session'
import { collectSelectableModules } from '../utils/modules'
import type { AppAction } from './actions'
import type { AppState } from './app-state'

const upsertSession = (sessions: SessionSummary[], session: Session): SessionSummary[] => {
  const existing = sessions.findIndex((item) => item.id === session.id)
  const next = existing >= 0 ? [...sessions] : [session, ...sessions]
  if (existing >= 0) next[existing] = { ...next[existing], ...session }
  return next.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

const removeSession = (sessions: SessionSummary[], sessionId: string) =>
  sessions.filter((session) => session.id !== sessionId)

const upsertMessage = (messages: SessionMessage[] = [], message: SessionMessage) => {
  const index = messages.findIndex((entry) => entry.id === message.id)
  if (index < 0) return [...messages, message]
  const next = [...messages]
  next[index] = { ...next[index], ...message }
  return next
}

const maybePersist = (session: Session | null) => {
  if (!session) return
  saveLocalSessionSnapshot(session)
}

const syncSelectedModule = (state: AppState, session: Session | null): string | null => {
  if (!session) return null
  const modules = collectSelectableModules(session)
  if (state.selectedModuleId && modules.some((module) => module.id === state.selectedModuleId)) {
    return state.selectedModuleId
  }
  return null
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'runtime/loaded':
      return { ...state, runtime: action.runtime }
    case 'sessions/loaded':
      return { ...state, loading: false, sessions: action.sessions }
    case 'session/selected':
      return {
        ...state,
        agentEvents: [],
        chatFilterModuleId: null,
        currentSession: action.session,
        currentSessionId: action.sessionId,
        selectedModuleId: syncSelectedModule(state, action.session),
      }
    case 'session/init': {
      maybePersist(action.session)
      if (state.currentSessionId && state.currentSessionId !== action.session.id) {
        return {
          ...state,
          sessions: upsertSession(state.sessions, action.session),
        }
      }
      return {
        ...state,
        currentSession: action.session,
        currentSessionId: action.session.id,
        selectedModuleId: syncSelectedModule(state, action.session),
        sessions: upsertSession(state.sessions, action.session),
      }
    }
    case 'session/updated': {
      const current =
        state.currentSession?.id === action.sessionId
          ? {
              ...state.currentSession,
              ...action.data,
              updatedAt: action.timestamp || Date.now(),
            }
          : state.currentSession
      if (current?.id === action.sessionId) maybePersist(current)
      return {
        ...state,
        currentSession: current,
        selectedModuleId: current?.id === action.sessionId ? syncSelectedModule(state, current) : state.selectedModuleId,
        sessions: state.sessions.map((session) =>
          session.id === action.sessionId
            ? ({ ...session, ...action.data, updatedAt: action.timestamp || Date.now() } as SessionSummary)
            : session,
        ),
      }
    }
    case 'message/upserted': {
      if (!state.currentSession) return state
      const current = {
        ...state.currentSession,
        messages: upsertMessage(state.currentSession.messages, action.message),
        updatedAt: action.timestamp || Date.now(),
      }
      maybePersist(current)
      return {
        ...state,
        currentSession: current,
        sessions: upsertSession(state.sessions, current),
      }
    }
    case 'agent/event':
      return { ...state, agentEvents: [...state.agentEvents.slice(-200), action.event] }
    case 'pipeline/completed': {
      const patch: Partial<Session> = { status: 'completed' }
      return appReducer(state, {
        type: 'session/updated',
        data: patch,
        sessionId: action.sessionId,
        timestamp: action.timestamp,
      })
    }
    case 'pipeline/failed':
      return appReducer(state, {
        type: 'session/updated',
        data: { status: 'failed', error: action.message },
        sessionId: action.sessionId,
        timestamp: action.timestamp,
      })
    case 'session/deleted': {
      const isCurrent = state.currentSessionId === action.sessionId
      return {
        ...state,
        agentEvents: isCurrent ? [] : state.agentEvents,
        currentSession: isCurrent ? null : state.currentSession,
        currentSessionId: isCurrent ? null : state.currentSessionId,
        sessions: removeSession(state.sessions, action.sessionId),
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
    case 'settings/open':
      return { ...state, settingsDialogOpen: action.open }
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
