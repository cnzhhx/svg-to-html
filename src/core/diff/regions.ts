import { readRegions, type Region } from '../utils.js'
import type { SerializableRegion } from './types.js'

export const resolveDiffRegions = async ({
  regions,
  regionsPath,
}: {
  regions?: Region[]
  regionsPath?: string
}): Promise<SerializableRegion[]> =>
  (regions ?? (await readRegions(regionsPath))).map((region, index) => ({
    ...region,
    id: region.id ?? `region-${index + 1}`,
  }))
