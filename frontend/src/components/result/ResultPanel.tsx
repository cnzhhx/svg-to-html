import type { Session } from '../../types/session'
import { getSessionCompareEntryPath, getSessionRenderEntryPath, getSessionSourceEntryPath, hasPrimaryResults } from '../../utils/artifacts'
import { formatBytes, formatTokenCount, toPercent } from '../../utils/format'
import type { ResultViewMode } from '../../state/app-state'
import { ResultImageComparison } from './ResultImageComparison'
import type { ArtifactCacheMeta } from '../../utils/artifact-cache'

const readPositiveNumber = (value: unknown) => {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0
}

const tokenBadgesForResult = (result: Session['result'] | undefined) => {
  const outputTokens = readPositiveNumber(result?.outputTokens)
  const cachedInputTokens = readPositiveNumber(result?.cachedInputTokens)
  const uncachedInputTokens = readPositiveNumber(result?.uncachedInputTokens)
  return [
    { label: '输出', value: outputTokens },
    { label: '缓存输入', value: cachedInputTokens },
    { label: '非缓存输入', value: uncachedInputTokens },
  ].flatMap((item) => {
    const text = formatTokenCount(item.value)
    return text ? [{ ...item, text }] : []
  })
}

export function ResultPanel({
  cacheBusy,
  cacheError,
  cacheMeta,
  chatOpen,
  comparePosition,
  onComparePositionChange,
  onDownloadZip,
  onOpenArtifact,
  onOpenLightbox,
  onPreviewWidthChange,
  onSelectModule,
  onViewModeChange,
  previewWidth,
  selectedModuleId,
  session,
  viewMode,
}: {
  cacheBusy: boolean
  cacheError: string | null
  cacheMeta?: ArtifactCacheMeta | null
  chatOpen: boolean
  comparePosition: number
  onComparePositionChange: (value: number) => void
  onDownloadZip: () => void
  onOpenArtifact: (kind: 'compare' | 'render' | 'source') => void
  onOpenLightbox: (src: string) => void
  onPreviewWidthChange: (value: number) => void
  onSelectModule: (moduleId: string) => void
  onViewModeChange: (mode: ResultViewMode) => void
  previewWidth: number
  selectedModuleId: string | null
  session: Session | null
  viewMode: ResultViewMode
}) {
  const show = hasPrimaryResults(session)
  const result = session?.result
  const sourceEntryPath = getSessionSourceEntryPath(session)
  const renderEntryPath = getSessionRenderEntryPath(session)
  const compareEntryPath = getSessionCompareEntryPath(session)
  const tokenBadges = tokenBadgesForResult(result)

  return (
    <section className={`result-panel${show ? ' visible' : ''}`} id="resultPanel">
      <div className="result-panel-header">
        <div className="result-panel-heading">
          {result?.diffRatio !== undefined ? (
            <span className="result-diff-gap is-passed">还原度 {toPercent(Math.max(0, 1 - Number(result.diffRatio)))}</span>
          ) : null}
          {tokenBadges.length ? (
            <span className="result-token-group">
              {tokenBadges.map((badge) => (
                <span className="result-token-badge" key={badge.label}>
                  <span>{badge.label}</span>
                  <strong>{badge.text}</strong>
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <div className="result-panel-controls">
          <div className="result-view-toggle" role="group" aria-label="对比视图">
            <button className={`result-view-toggle-btn${viewMode === 'split' ? ' is-active' : ''}`} onClick={() => onViewModeChange('split')} type="button">分列</button>
            <button className={`result-view-toggle-btn${viewMode === 'slider' ? ' is-active' : ''}`} onClick={() => onViewModeChange('slider')} type="button">滑块</button>
          </div>
          {cacheBusy ? <span className="result-cache-status is-busy">本地缓存中</span> : null}
          {!cacheBusy && cacheMeta ? <span className="result-cache-status">本地 · {cacheMeta.fileCount ? `${cacheMeta.fileCount} 文件` : '已缓存'} · {formatBytes(cacheMeta.byteSize)}</span> : null}
          {cacheError ? <span className="result-cache-status is-error">{cacheError}</span> : null}
          <label className="result-size-control" htmlFor="previewSizeRange">
            <span>预览宽度</span>
            <input id="previewSizeRange" max={960} min={375} onChange={(event) => onPreviewWidthChange(Number(event.target.value))} step={5} type="range" value={previewWidth} />
            <span className="result-size-value">{previewWidth}px</span>
          </label>
        </div>
      </div>
      <ResultImageComparison
        cacheMeta={cacheMeta || null}
        chatOpen={chatOpen}
        comparePosition={comparePosition}
        onComparePositionChange={onComparePositionChange}
        onOpenLightbox={onOpenLightbox}
        onSelectModule={onSelectModule}
        previewWidth={previewWidth}
        selectedModuleId={selectedModuleId}
        session={session}
        viewMode={viewMode}
      />
      <div className="result-urls">
        {cacheMeta?.byteSize || result?.localArtifactCacheByteSize ? <span>本地缓存 {formatBytes(cacheMeta?.byteSize || result?.localArtifactCacheByteSize || 0)}</span> : null}
      </div>
      <div className="result-actions">
        {compareEntryPath ? <button className="link-btn" onClick={() => onOpenArtifact('compare')} type="button">打开对照页</button> : null}
        {sourceEntryPath && sourceEntryPath !== renderEntryPath ? <button className="link-btn" onClick={() => onOpenArtifact('source')} type="button">打开源码</button> : null}
        {renderEntryPath ? <button className="link-btn" onClick={() => onOpenArtifact('render')} type="button">{sourceEntryPath === renderEntryPath ? '打开源码/渲染预览' : '打开渲染预览'}</button> : null}
        {session?.id ? <button className="link-btn download-btn" onClick={onDownloadZip} type="button">下载 ZIP</button> : null}
      </div>
    </section>
  )
}
