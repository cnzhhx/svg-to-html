import { useEffect, useMemo, useState } from 'react'
import type { Job } from '../../types/job'
import { resultImageVersion, artifactFileUrl } from '../../utils/artifacts'
import { computeModuleOverlayBoxes, collectSelectableModules } from '../../utils/modules'
import { selectResultImageCards } from '../../state/selectors'
import type { ResultViewMode } from '../../state/app-state'
import { useSyncedScroll } from '../../hooks/useSyncedScroll'
import { createCachedArtifactObjectUrl, getCachedArtifactFiles } from '../../utils/artifact-cache'
import type { ArtifactCacheMeta } from '../../utils/artifact-cache'

type ImageLoadState = {
  status: 'error' | 'loaded'
  url: string
}

export function ResultImageComparison({
  comparePosition,
  cacheMeta,
  chatOpen,
  onComparePositionChange,
  onOpenLightbox,
  onSelectModule,
  previewWidth,
  selectedModuleId,
  job,
  viewMode,
}: {
  cacheMeta?: ArtifactCacheMeta | null
  chatOpen: boolean
  comparePosition: number
  onComparePositionChange: (value: number) => void
  onOpenLightbox: (src: string) => void
  onSelectModule: (moduleId: string) => void
  previewWidth: number
  selectedModuleId: string | null
  job: Job | null
  viewMode: ResultViewMode
}) {
  const syncScroll = useSyncedScroll()
  const sourceCards = useMemo(() => selectResultImageCards(job), [job])
  const imageVersion = useMemo(() => resultImageVersion(job), [job])
  const [cachedUrls, setCachedUrls] = useState<Record<string, string>>({})
  const [imageStates, setImageStates] = useState<Record<string, ImageLoadState>>({})
  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    const shouldUseCache = Boolean(
      job?.id &&
        job.__localOnly &&
        cacheMeta?.status === 'cached' &&
        sourceCards.some((card) => card.path && cacheMeta.paths?.includes(card.path)),
    )
    if (!shouldUseCache) {
      setCachedUrls((previous) => (Object.keys(previous).length ? {} : previous))
      return () => {}
    }
    void getCachedArtifactFiles(job!.id)
      .then(async (records) => {
        const entries: Record<string, string> = {}
        for (const card of sourceCards) {
          const url = await createCachedArtifactObjectUrl(card.path, records)
          entries[card.path] = url
          if (url.startsWith('blob:')) objectUrls.push(url)
        }
        if (!cancelled) setCachedUrls(entries)
      })
      .catch(() => {
        if (!cancelled) setCachedUrls((previous) => (Object.keys(previous).length ? {} : previous))
      })
    return () => {
      cancelled = true
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [cacheMeta?.status, cacheMeta?.paths, job, sourceCards])
  const cards = sourceCards.map((card) => ({
    ...card,
    url: cachedUrls[card.path] || artifactFileUrl(card.path, job, imageVersion),
  }))
  const imageStatus = (kind: string, url: string) => {
    const state = imageStates[kind]
    return state?.url === url ? state.status : 'loading'
  }
  const updateImageStatus = (kind: string, url: string, status: ImageLoadState['status']) => {
    setImageStates((previous) => ({ ...previous, [kind]: { status, url } }))
  }
  const svgCard = cards.find((card) => card.kind === 'svg')
  const renderCard = cards.find((card) => card.kind === 'render')
  const effectiveMode = viewMode === 'slider' && svgCard && renderCard ? 'slider' : 'split'
  const designWidth = Number(job?.result?.designWidth || 0)
  const designHeight = Number(job?.result?.designHeight || 0)
  const designAspectRatio = designWidth > 0 && designHeight > 0 ? designWidth / designHeight : undefined
  const boxes = useMemo(() => {
    if (!chatOpen) return []
    return computeModuleOverlayBoxes({
      designHeight: Number(job?.result?.designHeight || 0),
      designWidth: Number(job?.result?.designWidth || 0),
      modules: collectSelectableModules(job),
    })
  }, [
    chatOpen,
    job?.result?.designHeight,
    job?.result?.designWidth,
    job?.result?.moduleAgentRuns,
    job?.result?.moduleCount,
    job?.result?.moduleFailedIds,
    job?.result?.modulePlanModules,
    job?.result?.moduleAgentThreadIds,
    job?.messages,
  ])

  if (!cards.length) return <div className="result-grid" />

  if (effectiveMode === 'slider' && svgCard && renderCard) {
    const renderStatus = imageStatus(renderCard.kind, renderCard.url)
    const svgStatus = imageStatus(svgCard.kind, svgCard.url)
    const sliderError = renderStatus === 'error' || svgStatus === 'error'
    const sliderLoading = renderStatus !== 'loaded' || svgStatus !== 'loaded'
    return (
      <div className="result-grid is-slider" style={{ ['--result-preview-width' as string]: `${previewWidth}px` }}>
        <div className="result-card comparison-card">
          <div className="result-card-title comparison-card-title">
            <span>视觉对比</span>
          </div>
          <div className="comparison-frame" data-result-scroll-frame>
            <div className="comparison-stage" data-comparison-stage style={{ ['--comparison-position' as string]: `${comparePosition}%`, ...(designAspectRatio ? { aspectRatio: String(designAspectRatio) } : {}) }}>
              {sliderLoading ? (
                <div className={`result-image-status${sliderError ? ' is-error' : ''}`} role="status">
                  {!sliderError ? <span className="loading-spinner" aria-hidden="true" /> : null}
                  <span>{sliderError ? '对比图片加载失败' : '正在加载对比图片'}</span>
                </div>
              ) : null}
              <div className="comparison-layer render">
                <img
                  alt="渲染预览"
                  className={renderStatus === 'loaded' ? 'is-loaded' : 'is-loading'}
                  key={renderCard.url}
                  onError={() => updateImageStatus(renderCard.kind, renderCard.url, 'error')}
                  onLoad={() => updateImageStatus(renderCard.kind, renderCard.url, 'loaded')}
                  src={renderCard.url}
                />
              </div>
              <div className="comparison-layer svg">
                <img
                  alt="SVG 渲染"
                  className={svgStatus === 'loaded' ? 'is-loaded' : 'is-loading'}
                  key={svgCard.url}
                  onError={() => updateImageStatus(svgCard.kind, svgCard.url, 'error')}
                  onLoad={() => updateImageStatus(svgCard.kind, svgCard.url, 'loaded')}
                  src={svgCard.url}
                />
              </div>
              <div className="comparison-handle" aria-hidden="true">
                <span className="comparison-handle-knob" />
              </div>
              <input
                aria-label="拖动切换 SVG 和 Render 对比"
                className="comparison-range"
                max={100}
                min={0}
                onChange={(event) => onComparePositionChange(Number(event.target.value))}
                type="range"
                value={comparePosition}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="result-grid" style={{ ['--result-preview-width' as string]: `${previewWidth}px` }}>
      {cards.map((card) => (
        <div className="result-card" key={card.kind}>
          <div className="result-card-title">{card.title}</div>
          <div className="result-card-frame" data-result-scroll-frame onScroll={syncScroll}>
            <div className="result-card-preview" style={designAspectRatio ? { aspectRatio: String(designAspectRatio) } : undefined}>
              {imageStatus(card.kind, card.url) !== 'loaded' ? (
                <div className={`result-image-status${imageStatus(card.kind, card.url) === 'error' ? ' is-error' : ''}`} role="status">
                  {imageStatus(card.kind, card.url) !== 'error' ? <span className="loading-spinner" aria-hidden="true" /> : null}
                  <span>{imageStatus(card.kind, card.url) === 'error' ? `${card.title}加载失败` : `正在加载${card.title}`}</span>
                </div>
              ) : null}
              <img
                alt={card.title}
                className={imageStatus(card.kind, card.url) === 'loaded' ? 'is-loaded' : 'is-loading'}
                data-result-kind={card.kind}
                key={card.url}
                onClick={() => imageStatus(card.kind, card.url) === 'loaded' && onOpenLightbox(card.url)}
                onError={() => updateImageStatus(card.kind, card.url, 'error')}
                onLoad={() => updateImageStatus(card.kind, card.url, 'loaded')}
                src={card.url}
              />
              {card.kind === 'render' && chatOpen && imageStatus(card.kind, card.url) === 'loaded' ? (
                <div className="module-overlay" data-module-overlay>
                  {boxes.map((box) => (
                    <button
                      className={`module-overlay-box${box.id === selectedModuleId ? ' is-selected' : ''}`}
                      key={box.id}
                      onClick={() => onSelectModule(box.id)}
                      style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
                      title={box.id}
                      type="button"
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
