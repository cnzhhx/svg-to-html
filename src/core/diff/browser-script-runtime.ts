import { DIFF_BROWSER_REPORT_RUNTIME } from './browser-script-report.js'
import { DIFF_BROWSER_SETUP_RUNTIME } from './browser-script-setup.js'

// Keep the pixel algorithm inside the browser page so canvas/image decoding
// behavior matches the rendered screenshots that verification consumes.
const DIFF_BROWSER_RUNTIME = [
  DIFF_BROWSER_SETUP_RUNTIME,
  DIFF_BROWSER_REPORT_RUNTIME,
].join('\n')

export { DIFF_BROWSER_RUNTIME }
