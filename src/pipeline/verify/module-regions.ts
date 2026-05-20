import { MODULE_DIFF_RATIO_THRESHOLD } from '../../config/runtime.js'
import type { DiffBoundingBox, RegionStat } from '../../core/diff.js'
import type { Region } from '../../core/utils.js'
import type { ModuleRegionStat, ModuleRegionSummary } from './types.js'

const formatBox = (box: DiffBoundingBox | Region) =>
  `x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`

const sortModuleRegionStats = (moduleRegionStats: ModuleRegionStat[]) =>
  [...moduleRegionStats].sort((left, right) => {
    if (right.diffPixels !== left.diffPixels) return right.diffPixels - left.diffPixels
    if (right.diffRatio !== left.diffRatio) return right.diffRatio - left.diffRatio
    return left.id.localeCompare(right.id)
  })

const normalizeModuleRegions = (regions: Region[]) =>
  regions.map((region, index) => ({
    ...region,
    id: region.id ?? `region-${index + 1}`,
  }))

const buildModuleRegionStats = ({
  regions,
  regionStats,
}: {
  regions: Region[]
  regionStats: RegionStat[]
}): ModuleRegionStat[] => {
  const statsById = new Map(regionStats.map((stat) => [stat.id, stat]))

  return regions.map((region, index) => {
    const id = region.id ?? `region-${index + 1}`
    const stats = statsById.get(id)

    return {
      boundingBox: stats?.boundingBox ?? null,
      diffPixels: stats?.diffPixels ?? 0,
      diffRatio: stats?.diffRatio ?? 0,
      id,
      maxChannelDelta: stats?.maxChannelDelta ?? 0,
      region: {
        height: region.height,
        id,
        width: region.width,
        x: region.x,
        y: region.y,
      },
    }
  })
}

const summarizeModuleRegions = (
  moduleRegionStats: ModuleRegionStat[],
): ModuleRegionSummary => {
  const sorted = sortModuleRegionStats(moduleRegionStats)
  return {
    activeModules: moduleRegionStats.filter((stat) => stat.diffPixels > 0).length,
    topModules: sorted.slice(0, 5),
    totalModules: moduleRegionStats.length,
  }
}

const findModuleRegionDiffFailures = (moduleRegionStats: ModuleRegionStat[]) =>
  sortModuleRegionStats(moduleRegionStats).filter(
    (stat) => stat.diffRatio > MODULE_DIFF_RATIO_THRESHOLD,
  )

const formatModuleRegionStat = (stat: ModuleRegionStat) =>
  `- ${stat.id}: region ${formatBox(stat.region)}, diffRatio=${stat.diffRatio}, diffPixels=${stat.diffPixels}, diffBox=${
    stat.boundingBox ? formatBox(stat.boundingBox) : 'none'
  }, maxChannelDelta=${stat.maxChannelDelta}`

export {
  buildModuleRegionStats,
  findModuleRegionDiffFailures,
  formatModuleRegionStat,
  normalizeModuleRegions,
  sortModuleRegionStats,
  summarizeModuleRegions,
}
