export type LocalArtifactCacheMeta = {
  at?: number
  byteSize?: number
  error?: string
  fileCount?: number
  paths?: string[]
  status?: 'cached' | 'caching' | 'error'
}

export type ResultImageCard = {
  kind: 'svg' | 'render'
  path: string
  title: string
}
