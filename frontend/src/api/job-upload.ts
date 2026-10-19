import type { Job } from '../types/job'
import type { UploadQuota } from '../types/runtime'
import { ApiError, basePath } from './http'

export type UploadOptions = {
  model?: string
  outputFormat: string
  scale: number
  showcase?: boolean
}

export type UploadResponse = {
  designName: string
  job?: Job
  jobId?: string
  jobs?: Job[]
  jobIds?: string[]
  quota: UploadQuota
  status: string
}

export type UploadProgress = {
  loaded: number
  percent: number
  phase: 'processing' | 'uploading'
  total: number
}

const readXhrPayload = (request: XMLHttpRequest) => {
  if (request.response && typeof request.response === 'object') {
    return request.response as Record<string, unknown>
  }
  try {
    return JSON.parse(request.responseText || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

export const uploadSvg = (
  file: File,
  options: UploadOptions,
  onProgress?: (progress: UploadProgress) => void,
) => {
  const form = new FormData()
  form.append('svg', file)
  if (options.model) form.append('model', options.model)
  form.append('outputFormat', options.outputFormat)
  form.append('scale', String(options.scale))
  if (options.showcase) form.append('showcase', 'true')
  return new Promise<UploadResponse>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${basePath}/api/jobs`)
    request.setRequestHeader('X-Requested-With', 'svg-to-html')
    request.responseType = 'json'
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size
      const percent = total > 0 ? Math.min(99, Math.round((event.loaded / total) * 100)) : 0
      onProgress?.({ loaded: event.loaded, percent, phase: 'uploading', total })
    }
    request.upload.onload = () => {
      onProgress?.({ loaded: file.size, percent: 100, phase: 'processing', total: file.size })
    }
    request.onerror = () => reject(new ApiError('上传失败，请检查网络后重试', 0))
    request.onabort = () => reject(new ApiError('上传已取消', 0))
    request.onload = () => {
      const payload = readXhrPayload(request)
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(
          String(payload.error || request.statusText || '上传失败'),
          request.status,
          payload,
        ))
        return
      }
      resolve(payload as unknown as UploadResponse)
    }
    request.send(form)
  })
}
