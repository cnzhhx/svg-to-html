import type { Job } from '../types/job'
import { getJobRenderPngPath, getJobSvgPngPath, hasPrimaryResults } from '../utils/artifacts'
import { cachedRootArtifactPath } from '../utils/local-job'

export const selectResultImageCards = (job?: Job | null) => {
  if (!hasPrimaryResults(job)) return []
  return [
    { kind: 'svg' as const, path: getJobSvgPngPath(job) || cachedRootArtifactPath(job, 'svg.png'), title: 'SVG 渲染' },
    { kind: 'render' as const, path: getJobRenderPngPath(job) || cachedRootArtifactPath(job, 'render.png'), title: '渲染预览' },
  ].filter((card) => card.path)
}
