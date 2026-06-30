import type { AgentEvent } from '../types/events'
import type { Session } from '../types/session'
import { getSessionRenderPngPath, getSessionSvgPngPath, hasPrimaryResults } from '../utils/artifacts'
import { cachedRootArtifactPath } from '../utils/local-session'
import { collectChatFilterModules, collectSelectableModules } from '../utils/modules'
import { getWorkflowProgress } from '../utils/workflow'
import type { AppState } from './app-state'

export const selectCurrentSession = (state: AppState) => state.currentSession
export const selectSelectableModules = (state: AppState) => collectSelectableModules(state.currentSession)
export const selectChatFilterModules = (state: AppState) => collectChatFilterModules(state.currentSession)
export const selectWorkflowProgress = (state: AppState) => getWorkflowProgress(state.currentSession)

export const selectCanSendMessage = (state: AppState) =>
  Boolean(
    state.currentSession &&
      !state.runtime?.sessionChatDisabled &&
      state.selectedModuleId &&
      state.currentSession.status !== 'queued' &&
      state.currentSession.status !== 'running',
  )

export const selectResultImageCards = (session?: Session | null) => {
  if (!hasPrimaryResults(session)) return []
  return [
    { kind: 'svg' as const, path: getSessionSvgPngPath(session) || cachedRootArtifactPath(session, 'svg.png'), title: 'SVG 渲染' },
    { kind: 'render' as const, path: getSessionRenderPngPath(session) || cachedRootArtifactPath(session, 'render.png'), title: '渲染预览' },
  ].filter((card) => card.path)
}

export const moduleIdForAgentEvent = (event: AgentEvent) =>
  String(event.moduleId || event.item?.moduleId || '').trim()
