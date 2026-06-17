type VerifyResult = {
  artifactDir: string
  diffRatio: number
  renderPngPath: string
  svgPngPath: string
  mode?: 'full' | 'fast'
  sourceBasis?: string
  sourceRenderMode?: 'svg-image' | 'html'
}

type VerifyMode = 'full' | 'fast'

type VerifyOptions = {
  mode?: VerifyMode
  renderEntryPath: string
  scale?: number
  sourceBasis?: string
  sourceHtmlPath?: string
}

export type { VerifyMode, VerifyOptions, VerifyResult }
