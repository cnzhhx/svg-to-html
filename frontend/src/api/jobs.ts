import type { Job, JobDownloadKind, JobMessage, JobSummary } from '../types/job'
import { apiJson, apiUrl } from './http'

export const loadJobs = (signal?: AbortSignal) => apiJson<JobSummary[]>('/api/jobs', { signal })

export const loadJob = (id: string) => apiJson<Job>(`/api/jobs/${encodeURIComponent(id)}`)

export const startJob = (id: string) =>
  apiJson<{ jobId: string; status: string }>(`/api/jobs/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const sendJobMessage = (id: string, moduleId: string, text: string) =>
  apiJson<{ guidanceStatus?: string; message?: JobMessage; jobId: string; status: string }>(`/api/jobs/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ moduleId, text }),
  })

export const deleteJob = (id: string) =>
  apiJson<{ deleted: boolean; jobId: string }>(`/api/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })

export const jobDownloadUrl = (id: string, kind: JobDownloadKind = 'deliverable') =>
  apiUrl(`/api/jobs/${encodeURIComponent(id)}/download${kind === 'diagnostic' ? '?kind=diagnostic' : ''}`)
