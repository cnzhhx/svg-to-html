export type ModelChannel = {
  id: string
  name?: string
  provider?: string
  baseURL?: string
  apiKey?: string
  model?: string
  wireApi?: string
  runtime?: string
  reasoningEffort?: string
  maxOutputTokens?: string
  contextWindow?: string
  cliModel?: string
  runtimeTrace?: string
  runtimeTraceSampleChars?: string
  thinking?: string
}

export type RuntimeSettingValues = Record<string, boolean | number | string | null | undefined>
