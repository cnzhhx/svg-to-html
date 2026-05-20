import { createDiffBrowserScript } from './browser-script.js'
import { createDiffWrapperHtml } from './wrapper-html.js'
import type { SerializableRegion } from './types.js'

type DiffWrapperOptions = {
  htmlImageUrl: string
  regions: SerializableRegion[]
  svgImageUrl: string
  threshold: number
}

const createDiffWrapper = (options: DiffWrapperOptions) =>
  createDiffWrapperHtml({
    script: createDiffBrowserScript(options),
  })

export { createDiffWrapper }
