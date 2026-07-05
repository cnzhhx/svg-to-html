import type { Session } from '../types/session'
import { apiJson } from './http'

export type UploadOptions = {
  outputFormat: string
  scale: number
  sessionCount: number
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
  return apiJson<UploadResponse>('/api/upload', {
    method: 'POST',
    body: form,
  })
}
