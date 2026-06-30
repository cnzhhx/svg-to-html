import { useEffect, useMemo, useState } from 'react'
import type { Session } from '../../types/session'
import { workspaceFileUrl } from '../../utils/artifacts'
import { computeModuleOverlayBoxes, collectSelectableModules } from '../../utils/modules'
import { selectResultImageCards } from '../../state/selectors'
import type { ResultViewMode } from '../../state/app-state'
import { useSyncedScroll } from '../../hooks/useSyncedScroll'
import { createCachedArtifactObjectUrl, getCachedArtifactFiles } from '../../utils/artifact-cache'
import type { ArtifactCacheMeta } from '../../utils/artifact-cache'

export function ResultImageComparison({
  comparePosition,
  cacheMeta,
  chatOpen,
  onComparePositionChange,
  onOpenLightbox,
  onSelectModule,
  previewWidth,
  selectedModuleId,
  session,
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
  session: Session | null
  viewMode: ResultViewMode
}) {
  const syncScroll = useSyncedScroll()
  const sourceCards = useMemo(() => selectResultImageCards(session), [session])
  const [cachedUrls, setCachedUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    const shouldUseCache = Boolean(session?.id && cacheMeta?.status === 'cached' && (session.__localOnly || sourceCards.some((card) => card.path && cacheMeta.paths?.includes(card.path))))
    if (!shouldUseCache) {
      setCachedUrls({})
      return () => {}
    }
    void getCachedArtifactFiles(session!.id)
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
        if (!cancelled) setCachedUrls({})
      })
    return () => {
      cancelled = true
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [cacheMeta?.status, cacheMeta?.paths, session, sourceCards])
  const cards = sourceCards.map((card) => ({
    ...card,
    url: cachedUrls[card.path] || workspaceFileUrl(card.path, session),
  }))
  const svgCard = cards.find((card) => card.kind === 'svg')
  const renderCard = cards.find((card) => card.kind === 'render')
  const effectiveMode = viewMode === 'slider' && svgCard && renderCard ? 'slider' : 'split'
  const modules = collectSelectableModules(session)
  const boxes = computeModuleOverlayBoxes({
    designHeight: Number(session?.result?.designHeight || 0),
    designWidth: Number(session?.result?.designWidth || 0),
    modules,
  })

  if (!cards.length) return <div className="result-grid" />

  if (effectiveMode === 'slider' && svgCard && renderCard) {
    return (
      <div className="result-grid is-slider" style={{ ['--result-preview-width' as string]: `${previewWidth}px` }}>
        <div className="result-card comparison-card">
          <div className="result-card-title comparison-card-title">
            <span>视觉对比</span>
          </div>
          <div className="comparison-frame" data-result-scroll-frame>
            <div className="comparison-stage" data-comparison-stage style={{ ['--comparison-position' as string]: `${comparePosition}%` }}>
              <div className="comparison-layer render">
                <img src={renderCard.url} alt="渲染预览" />
              </div>
              <div className="comparison-layer svg">
                <img src={svgCard.url} alt="SVG 渲染" />
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
    <div className="result-grid" onScroll={syncScroll} style={{ ['--result-preview-width' as string]: `${previewWidth}px` }}>
      {cards.map((card) => (
        <div className="result-card" key={card.kind}>
          <div className="result-card-title">{card.title}</div>
          <div className="result-card-frame" data-result-scroll-frame>
            <div className="result-card-preview">
              <img alt={card.title} data-result-kind={card.kind} onClick={() => onOpenLightbox(card.url)} src={card.url} />
              {card.kind === 'render' && chatOpen ? (
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
