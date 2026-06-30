import type { Session } from '../types/session'
import { apiJson } from './http'

export type UploadOptions = {
  outputFormat: string
  scale: number
  sessionCount: number
  settings?: Record<string, unknown>
}

export type UploadResponse = {
  designName: string
  session?: Session
  sessionId?: string
  sessions?: Session[]
  sessionIds?: string[]
  status: string
}

export const uploadSvg = (file: File, options: UploadOptions) => {
  const form = new FormData()
  form.append('svg', file)
  form.append('outputFormat', options.outputFormat)
  form.append('scale', String(options.scale))
  form.append('sessionCount', String(options.sessionCount))
  if (options.settings !== undefined && Object.keys(options.settings).length > 0) {
    form.append('settings', JSON.stringify(options.settings))
  }
  return apiJson<UploadResponse>('/api/upload', {
    method: 'POST',
    body: form,
  })
}
