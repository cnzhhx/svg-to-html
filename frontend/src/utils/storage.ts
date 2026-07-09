export const STORAGE_KEYS = {
  clientId: 'svg2html:clientId',
  localArtifactDb: 'svg2html:artifactCache',
  localJobSnapshots: 'svg2html:jobSnapshots',
  runningPreviewFitModes: 'svg2html:runningPreviewFitModes:v1',
  resultComparePosition: 'svg2html:resultComparePosition',
  resultPreviewWidth: 'svg2html:resultPreviewWidth',
  resultViewMode: 'svg2html:resultViewMode:v2',
  jobs: 'svg2html:jobs',
  theme: 'svg2html:theme',
  uploadFormat: 'svg2html:uploadFormat',
  uploadModel: 'svg2html:uploadModel',
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
