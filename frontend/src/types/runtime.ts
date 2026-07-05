export type RuntimeInfo = {
  browserPath: string | null
  diffRatioThreshold: number
  enableSessionLocalStorage: boolean
  maxConcurrentAgents: number
  nodeVersion: string
  platform: string
  release: string
  sessionChatDisabled: boolean
  sessionDeleteDisabled: boolean
  workspaceRoot: string
}
