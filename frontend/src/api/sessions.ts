import type { Session, SessionMessage, SessionSummary } from '../types/session'
import { apiJson, apiUrl } from './http'

export const loadSessions = () => apiJson<SessionSummary[]>('/api/sessions')

export const loadSession = (id: string) => apiJson<Session>(`/api/sessions/${encodeURIComponent(id)}`)

export const startSession = (id: string, settings?: unknown) =>
  apiJson<{ sessionId: string; status: string }>(`/api/sessions/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    body: JSON.stringify(settings === undefined ? {} : { settings }),
  })

export const sendSessionMessage = (id: string, moduleId: string, text: string) =>
  apiJson<{ guidanceStatus?: string; message?: SessionMessage; sessionId: string; status: string }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ moduleId, text }),
  })

export const deleteSession = (id: string) =>
  apiJson<{ deleted: boolean; sessionId: string }>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })

export const sessionDownloadUrl = (id: string) => apiUrl(`/api/sessions/${encodeURIComponent(id)}/download`)
