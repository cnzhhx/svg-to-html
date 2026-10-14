export type UploadQuota = {
  date: string
  limit: number
  remaining: number
  used: number
}

export type RuntimeInfo = {
  adminMode: boolean
  initialized: boolean
  settingsRevision: number
  quotaEnabled: boolean
  accessIsolationEnabled: boolean
  allowUserShowcase: boolean
  enableJobLocalStorage: boolean
  coreServiceUrlConfigured: boolean
  jobChatDisabled: boolean
  jobDeleteDisabled: boolean
  maxSvgUploadBytes: number
  modelOptions: string[]
  artifactRoot: string
  uploadQuota: UploadQuota
}
