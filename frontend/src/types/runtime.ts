export type RuntimeSettingsField = {
  configKey: string
  configured: boolean
  defaultValue?: boolean | number | string | null
  description: string
  envName: string
  hasFrontendOverride: boolean
  options?: string[]
  restartRequired?: boolean
  section: string
  sensitive?: boolean
  source: 'default' | 'env' | 'frontend'
  type: 'boolean' | 'number' | 'string'
  value: boolean | number | string | null
}

export type RuntimeInfo = {
  browserPath: string | null
  diffRatioThreshold: number
  enableSessionLocalStorage: boolean
  frontendSettingsEnabled: boolean
  frontendSettingsFields: RuntimeSettingsField[]
  maxConcurrentAgents: number
  nodeVersion: string
  platform: string
  release: string
  sessionChatDisabled: boolean
  sessionDeleteDisabled: boolean
  workspaceRoot: string
}
