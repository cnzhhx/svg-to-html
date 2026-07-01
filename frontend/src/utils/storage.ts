export const STORAGE_KEYS = {
  activeModelChannel: 'svg2html:activeModelChannel:v1',
  clientId: 'svg2html:clientId',
  localArtifactDb: 'svg2html:artifactCache',
  localSessionSnapshots: 'svg2html:sessionSnapshots',
  modelChannels: 'svg2html:modelChannels:v1',
  runningPreviewFitModes: 'svg2html:runningPreviewFitModes:v1',
  resultComparePosition: 'svg2html:resultComparePosition',
  resultPreviewWidth: 'svg2html:resultPreviewWidth',
  resultViewMode: 'svg2html:resultViewMode:v2',
  runSettings: 'svg2html:runSettings:v1',
  sessions: 'svg2html:sessions',
  theme: 'svg2html:theme',
  uploadFormat: 'svg2html:uploadFormat',
  uploadScale: 'svg2html:uploadScale',
} as const

export function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJsonStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/private-mode failures
  }
}

export function readStringStorage(key: string, fallback = '') {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

export function writeStringStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export function readNumberStorage(key: string, fallback: number) {
  const value = Number(readStringStorage(key, ''))
  return Number.isFinite(value) ? value : fallback
}
