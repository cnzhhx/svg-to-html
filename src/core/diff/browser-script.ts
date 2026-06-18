import { DIFF_BROWSER_RUNTIME } from './browser-script-runtime.js'

type DiffBrowserScriptOptions = {
  renderImageUrl: string
  svgImageUrl: string
  threshold: number
}

const createDiffBrowserScript = ({
  renderImageUrl,
  svgImageUrl,
  threshold,
}: DiffBrowserScriptOptions) =>
  [
    `const svgUrl = ${JSON.stringify(svgImageUrl)}`,
    `const renderUrl = ${JSON.stringify(renderImageUrl)}`,
    `const threshold = ${threshold}`,
    '',
    DIFF_BROWSER_RUNTIME,
  ].join('\n')

export { createDiffBrowserScript }
