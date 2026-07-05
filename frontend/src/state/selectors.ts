import type { Session } from '../types/session'
import { getSessionRenderPngPath, getSessionSvgPngPath, hasPrimaryResults } from '../utils/artifacts'
import { cachedRootArtifactPath } from '../utils/local-session'

export const selectResultImageCards = (session?: Session | null) => {
  if (!hasPrimaryResults(session)) return []
  return [
    { kind: 'svg' as const, path: getSessionSvgPngPath(session) || cachedRootArtifactPath(session, 'svg.png'), title: 'SVG 渲染' },
    { kind: 'render' as const, path: getSessionRenderPngPath(session) || cachedRootArtifactPath(session, 'render.png'), title: '渲染预览' },
  ].filter((card) => card.path)
}
