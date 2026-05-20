import type { TextLayoutBlock } from '../text-layout.js'
import type { Region } from '../utils.js'
import {
  appendIfDistinct,
  expandRegion,
  overlapRatio,
  uniqSortedByThreshold,
} from './geometry.js'
import type { DiffCluster, OcrRegionSource } from './types.js'

const mergeRegionPair = (
  left: OcrRegionSource,
  right: OcrRegionSource,
): OcrRegionSource => {
  const minX = Math.min(left.x, right.x)
  const minY = Math.min(left.y, right.y)
  const maxX = Math.max(left.x + left.width, right.x + right.width)
  const maxY = Math.max(left.y + left.height, right.y + right.height)

  return {
    ...left,
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY,
  }
}

const mergeNearbyRegions = (regions: OcrRegionSource[]) => {
  const sorted = [...regions].sort((left, right) => {
    if (left.y !== right.y) return left.y - right.y
    return left.x - right.x
  })

  const merged: OcrRegionSource[] = []

  sorted.forEach((candidate) => {
    const target = merged.find((existing) => {
      const sameRow = Math.abs(existing.y - candidate.y) <= 20
      const similarHeight = Math.abs(existing.height - candidate.height) <= 32
      const horizontalGap =
        candidate.x > existing.x
          ? candidate.x - (existing.x + existing.width)
          : 0
      const unionWidth =
        Math.max(existing.x + existing.width, candidate.x + candidate.width) -
        Math.min(existing.x, candidate.x)
      const upperHalf = existing.y <= 1100 && candidate.y <= 1100
      const narrowFragments =
        existing.width <= 220 &&
        candidate.width <= 220 &&
        existing.height <= 90 &&
        candidate.height <= 90

      return (
        sameRow &&
        similarHeight &&
        horizontalGap >= 0 &&
        horizontalGap <= 48 &&
        unionWidth <= 320 &&
        upperHalf &&
        narrowFragments
      )
    })

    if (!target) {
      merged.push(candidate)
      return
    }

    const union = mergeRegionPair(target, candidate)
    target.x = union.x
    target.y = union.y
    target.width = union.width
    target.height = union.height
  })

  return merged
}

const isStandardTextLikeCluster = (cluster: DiffCluster) => {
  const box = cluster.boundingBox
  const area = box.width * box.height

  return (
    box.height <= 140 &&
    box.width <= 420 &&
    box.width >= 32 &&
    box.height >= 18 &&
    area <= 42000
  )
}

const isWideBottomTextLikeCluster = ({
  cluster,
  height,
  width,
}: {
  cluster: DiffCluster
  height: number
  width: number
}) => {
  const box = cluster.boundingBox

  return (
    box.width >= Math.round(width * 0.55) &&
    box.width <= Math.round(width * 0.98) &&
    box.height >= 40 &&
    box.height <= 120 &&
    box.y >= Math.round(height * 0.7)
  )
}

const extendRepeatedTitleRegions = ({
  boundsHeight,
  boundsWidth,
  regions,
}: {
  boundsHeight: number
  boundsWidth: number
  regions: OcrRegionSource[]
}) => {
  const titleLikeRegions = regions.filter(
    (region) =>
      region.width >= 120 &&
      region.width <= 240 &&
      region.height >= 28 &&
      region.height <= 72 &&
      region.y >= Math.round(boundsHeight * 0.45),
  )

  const xs = uniqSortedByThreshold(
    titleLikeRegions.map((region) => region.x),
    48,
  ).slice(0, 2)
  const ys = uniqSortedByThreshold(
    titleLikeRegions.map((region) => region.y),
    96,
  ).slice(0, 2)

  if (xs.length < 2 || ys.length < 2) return regions

  const averageWidth = Math.round(
    titleLikeRegions.reduce((sum, region) => sum + region.width, 0) /
      titleLikeRegions.length,
  )
  const averageHeight = Math.round(
    titleLikeRegions.reduce((sum, region) => sum + region.height, 0) /
      titleLikeRegions.length,
  )

  let id = regions.length + 1
  const output = [...regions]

  ys.forEach((y) => {
    xs.forEach((x) => {
      appendIfDistinct({
        candidate: expandRegion({
          boundsHeight,
          boundsWidth,
          paddingX: 10,
          paddingY: 8,
          region: {
            height: averageHeight,
            id: `auto-text-${id}`,
            width: averageWidth,
            x,
            y,
          },
        }),
        collection: output,
      })
      id += 1
    })
  })

  return output
}

const extendButtonRegions = ({
  boundsWidth,
  boundsHeight,
  regions,
}: {
  boundsWidth: number
  boundsHeight: number
  regions: OcrRegionSource[]
}) => {
  const output = [...regions]
  let id = output.length + 1

  regions
    .filter(
      (region) =>
        region.width >= 250 &&
        region.width <= Math.round(boundsWidth * 0.98) &&
        region.height >= 40 &&
        region.height <= 160 &&
        region.y >= Math.round(boundsHeight * 0.55),
    )
    .forEach((region) => {
      const candidateHeight = Math.min(72, Math.max(48, region.height))
      const candidateY = Math.min(
        boundsHeight - candidateHeight,
        region.y +
          Math.max(0, Math.round((region.height - candidateHeight) / 2)),
      )

      appendIfDistinct({
        candidate: {
          height: candidateHeight,
          id: `auto-text-${id}`,
          width: region.width,
          x: region.x,
          y: candidateY,
        },
        collection: output,
      })
      id += 1
    })

  return output
}

const buildTrackedOcrRegions = ({
  blocks,
  height,
  width,
}: {
  blocks: TextLayoutBlock[]
  height: number
  width: number
}) => {
  const trackedRegions: OcrRegionSource[] = []

  blocks
    .filter((block): block is TextLayoutBlock & { region: Region } =>
      Boolean(block.region),
    )
    .filter((block) => {
      const region = block.region
      const area = region.width * region.height
      return (
        region.width >= 36 &&
        region.height >= 20 &&
        (region.width >= 72 || area >= 1800)
      )
    })
    .forEach((block) => {
      const region = block.region
      const expanded = expandRegion({
        boundsHeight: height,
        boundsWidth: width,
        paddingX: region.width <= 48 ? 8 : 10,
        paddingY: region.height <= 48 ? 8 : 6,
        region: {
          height: region.height,
          id: block.id,
          width: region.width,
          x: region.x,
          y: region.y,
        },
      })

      appendIfDistinct({
        candidate: expanded,
        collection: trackedRegions,
      })
    })

  return trackedRegions.slice(0, 64)
}

const buildAutoOcrRegions = ({
  diffReport,
  height,
  width,
}: {
  diffReport: { clusters: DiffCluster[] }
  height: number
  width: number
}): OcrRegionSource[] => {
  const rawCandidates = diffReport.clusters
    .filter(
      (cluster) =>
        isStandardTextLikeCluster(cluster) ||
        isWideBottomTextLikeCluster({ cluster, height, width }),
    )
    .slice(0, 16)
    .map((cluster, index) => {
      const region = {
        height: cluster.boundingBox.height,
        id: `auto-text-${index + 1}`,
        width: cluster.boundingBox.width,
        x: cluster.boundingBox.x,
        y: cluster.boundingBox.y,
      }

      if (isWideBottomTextLikeCluster({ cluster, height, width })) {
        const centeredHeight = Math.min(72, Math.max(48, region.height))
        return expandRegion({
          boundsHeight: height,
          boundsWidth: width,
          paddingX: 12,
          paddingY: 6,
          region: {
            ...region,
            height: centeredHeight,
            y:
              region.y +
              Math.max(0, Math.round((region.height - centeredHeight) / 2)),
          },
        })
      }

      return expandRegion({
        boundsHeight: height,
        boundsWidth: width,
        paddingX: 12,
        paddingY: 10,
        region,
      })
    })

  const deduped: OcrRegionSource[] = []
  rawCandidates.forEach((candidate) => {
    appendIfDistinct({
      candidate,
      collection: deduped,
    })
  })

  return extendButtonRegions({
    boundsWidth: width,
    boundsHeight: height,
    regions: extendRepeatedTitleRegions({
      boundsHeight: height,
      boundsWidth: width,
      regions: mergeNearbyRegions(deduped),
    }),
  }).slice(0, 16)
}

const createOcrCoverageWarnings = ({
  clusters,
  height,
  ocrRegions,
  width,
}: {
  clusters: DiffCluster[]
  height: number
  ocrRegions: OcrRegionSource[]
  width: number
}) =>
  clusters
    .filter(
      (cluster) =>
        isStandardTextLikeCluster(cluster) ||
        isWideBottomTextLikeCluster({ cluster, height, width }),
    )
    .filter((cluster) => {
      const clusterRegion: Region = {
        height: cluster.boundingBox.height,
        width: cluster.boundingBox.width,
        x: cluster.boundingBox.x,
        y: cluster.boundingBox.y,
      }

      return !ocrRegions.some(
        (region) => overlapRatio(clusterRegion, region) >= 0.3,
      )
    })
    .slice(0, 6)
    .map((cluster) => {
      const box = cluster.boundingBox
      return `存在未纳入 OCR 的文本候选差异区：x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}；不要把当前 text-insights 视为文本已通过。`
    })

export {
  buildAutoOcrRegions,
  buildTrackedOcrRegions,
  createOcrCoverageWarnings,
  isStandardTextLikeCluster,
  isWideBottomTextLikeCluster,
}
