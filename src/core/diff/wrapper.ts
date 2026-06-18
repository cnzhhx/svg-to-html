import { createDiffBrowserScript } from './browser-script.js'
import { createDiffWrapperHtml } from './wrapper-html.js'

type DiffWrapperOptions = {
  renderImageUrl: string
  svgImageUrl: string
  threshold: number
}

const createDiffWrapper = (options: DiffWrapperOptions) =>
  createDiffWrapperHtml({
    script: createDiffBrowserScript(options),
  })

export { createDiffWrapper }
