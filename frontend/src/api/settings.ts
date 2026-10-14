import { apiJson } from './http'

export type OperatingSettings = {
  accessIsolationEnabled: boolean
  quotaEnabled: boolean
  dailyUploadLimit: number
  timeZone: string
  maxSvgUploadMb: number
  estimatedTaskMinutes: number
  allowUserShowcase: boolean
}
export type SettingsSnapshot = { revision: number; settings: OperatingSettings }
export type QueueSettings = { revision: number; maxConcurrentJobs: number }
export const loadQueueSettings = () => apiJson<QueueSettings>('/api/admin/queue-settings')
export const saveQueueSettings = (value: QueueSettings) => apiJson<QueueSettings>('/api/admin/queue-settings', { method: 'PUT', body: JSON.stringify(value) })
export type AdminStatus = { initialized: boolean; adminMode: boolean; legacyAvailable: boolean; username?: string }
export const loadAdminStatus = () => apiJson<AdminStatus>('/api/admin/session')
export const loadSetup = () => apiJson<AdminStatus & { settings?: OperatingSettings }>('/api/setup')
export const loadSettings = () => apiJson<SettingsSnapshot>('/api/admin/settings')
export const saveSettings = (value: SettingsSnapshot) => apiJson<SettingsSnapshot>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(value) })
export const loginAdmin = (value: { username?: string; password?: string; key?: string }) => apiJson<AdminStatus>('/api/admin/session', { method: 'POST', body: JSON.stringify(value) })
export const setupAdmin = (value: { username: string; password: string; token: string; settings: OperatingSettings }) => apiJson<AdminStatus>('/api/setup', { method: 'POST', body: JSON.stringify(value) })
export const changePassword = (currentPassword: string, password: string) => apiJson('/api/admin/password', { method: 'PUT', body: JSON.stringify({ currentPassword, password }) })
export const recoverPassword = (token: string, password: string) => apiJson('/api/admin/recovery', { method: 'POST', body: JSON.stringify({ token, password }) })
export const setJobShowcase = (id: string, showcase: boolean, revision: number) => apiJson<{ revision: number }>(`/api/admin/jobs/${encodeURIComponent(id)}/showcase`, { method: 'PUT', body: JSON.stringify({ showcase, revision }) })
