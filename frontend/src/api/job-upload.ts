import type { Job } from '../types/job'
import { apiJson } from './http'

export type UploadOptions = {
  model?: string
  outputFormat: string
  scale: number
  jobCount: number
}

export type UploadResponse = {
  designName: string
  job?: Job
  jobId?: string
  jobs?: Job[]
  jobIds?: string[]
  status: string
}

export const uploadSvg = (file: File, options: UploadOptions) => {
  const form = new FormData()
  form.append('svg', file)
  if (options.model) form.append('model', options.model)
  form.append('outputFormat', options.outputFormat)
  form.append('scale', String(options.scale))
  form.append('jobCount', String(options.jobCount))
  return apiJson<UploadResponse>('/api/jobs', {
    method: 'POST',
    body: form,
  })
}
