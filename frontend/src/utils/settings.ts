import type { ModelChannel, RuntimeSettingValues } from '../types/settings'
import { STORAGE_KEYS, readJsonStorage, readStringStorage, writeJsonStorage, writeStringStorage } from './storage'

export const BACKEND_ENV_MODEL_CHANNEL_ID = '__backend_env__'

export const SETTINGS_SECTIONS = [
  { id: 'model', label: '大模型配置' },
  { id: 'agent', label: 'Agent' },
  { id: 'diff', label: '还原度评估' },
  { id: 'workflow', label: '工作流' },
  { id: 'session', label: 'Session' },
  { id: 'browser', label: '浏览器' },
  { id: 'logging', label: '日志' },
  { id: 'runtime', label: '运行时' },
] as const

const isRuntimeSettingValue = (value: unknown): value is boolean | number | string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

export function readStoredRunSettings(): RuntimeSettingValues {
  const values = readJsonStorage<Record<string, unknown>>(STORAGE_KEYS.runSettings, {})
  const result: RuntimeSettingValues = {}
  for (const [key, value] of Object.entries(values)) {
    if (isRuntimeSettingValue(value)) result[key] = value
  }
  return result
}

export function writeStoredRunSettings(values: RuntimeSettingValues, sensitiveEnvNames: Set<string> = new Set()) {
  const persisted = Object.fromEntries(
    Object.entries(values).filter(([envName, value]) => !sensitiveEnvNames.has(envName) && isRuntimeSettingValue(value)),
  )
  writeJsonStorage(STORAGE_KEYS.runSettings, persisted)
}

export function readStoredModelChannels(): ModelChannel[] {
  const channels = readJsonStorage<unknown>(STORAGE_KEYS.modelChannels, [])
  if (!Array.isArray(channels)) return []
  return channels.flatMap((channel) => {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return []
    const value = channel as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (!id) return []
    return [{
      id,
      name: typeof value.name === 'string' ? value.name : '',
      provider: typeof value.provider === 'string' ? value.provider : '',
      baseURL: typeof value.baseURL === 'string' ? value.baseURL : '',
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      model: typeof value.model === 'string' ? value.model : '',
      wireApi: typeof value.wireApi === 'string' ? value.wireApi : 'chat-completions',
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
    }]
  })
}

export function writeStoredModelChannels(channels: ModelChannel[], activeChannelId: string) {
  const safeChannels = channels.map(({ apiKey: _apiKey, ...channel }) => channel)
  writeJsonStorage(STORAGE_KEYS.modelChannels, safeChannels)
  writeStringStorage(STORAGE_KEYS.activeModelChannel, activeChannelId || BACKEND_ENV_MODEL_CHANNEL_ID)
}

export function readStoredActiveModelChannelId(channels = readStoredModelChannels()) {
  const stored = readStringStorage(STORAGE_KEYS.activeModelChannel, '')
  if (stored === BACKEND_ENV_MODEL_CHANNEL_ID) return ''
  if (channels.some((channel) => channel.id === stored)) return stored
  return channels[0]?.id || ''
}

export function getActiveModelChannel(channels = readStoredModelChannels()) {
  const activeId = readStoredActiveModelChannelId(channels)
  if (!activeId) return null
  return channels.find((channel) => channel.id === activeId) || channels[0] || null
}

export function createModelChannel(overrides: Partial<ModelChannel> = {}, defaults: Partial<ModelChannel> = {}): ModelChannel {
  const id = overrides.id || `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    apiKey: '',
    baseURL: defaults.baseURL || '',
    id,
    model: defaults.model || '',
    name: defaults.name || defaults.provider || '自定义渠道',
    provider: defaults.provider || '',
    reasoningEffort: defaults.reasoningEffort || '',
    wireApi: defaults.wireApi || 'chat-completions',
    ...overrides,
  }
}

export function getRuntimeFieldBaseline(field?: { defaultValue?: unknown; sensitive?: boolean; value?: unknown }, includeSensitive = false) {
  if (!field || (field.sensitive && !includeSensitive)) return ''
  const value = field.value ?? field.defaultValue
  return value === null || value === undefined ? '' : String(value)
}

export function getRunSettingsPayload(frontendSettingsEnabled = true): Record<string, unknown> {
  if (!frontendSettingsEnabled) return {}
  const payload: Record<string, unknown> = Object.fromEntries(
    Object.entries(readStoredRunSettings()).filter(([, value]) => value !== '' && value !== null && value !== undefined),
  )
  const channel = getActiveModelChannel()
  if (channel && channel.baseURL?.trim() && channel.model?.trim()) {
    const provider = channel.provider?.trim() || channel.name?.trim() || 'frontend-model'
    payload.MODEL_PROVIDER = provider
    payload.MODEL_PROVIDER_NAME = channel.name?.trim() || provider
    payload.MODEL_BASE_URL = channel.baseURL.trim()
    payload.MODEL_ID = channel.model.trim()
    payload.MODEL_WIRE_API = channel.wireApi || 'chat-completions'
    if (channel.apiKey?.trim()) payload.MODEL_API_KEY = channel.apiKey.trim()
    if (channel.reasoningEffort) payload.MODEL_REASONING_EFFORT = channel.reasoningEffort
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== '' && value !== null && value !== undefined))
}
