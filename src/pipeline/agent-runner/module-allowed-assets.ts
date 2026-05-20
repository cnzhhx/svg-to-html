import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { SvgVerticalModule } from '../../core/svg-vertical-modules/types.js'
import type { Region } from '../../core/utils.js'
import { writeJsonFile } from '../../core/utils.js'

type JsonRecord = Record<string, unknown>

type ModuleAllowedAssetsResult = {
  allowedAssetsPath: string
  assetCount: number
  moduleOcrBlocksPath: string
  ocrBlockCount: number
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const getNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const getRegion = (value: unknown): Region | undefined => {
  if (!isRecord(value)) return undefined
  const x = getNumber(value.x)
  const y = getNumber(value.y)
  const width = getNumber(value.width)
  const height = getNumber(value.height)
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined
  }
  return { x, y, width, height }
}

const intersects = (left: Region, right: Region) => {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  return x2 > x1 && y2 > y1
}

const expandRegion = (region: Region, padding = 2): Region => ({
  height: region.height + padding * 2,
  width: region.width + padding * 2,
  x: region.x - padding,
  y: region.y - padding,
})

const writeJsonFileIfChanged = async (filePath: string, payload: unknown) => {
  const content = `${JSON.stringify(payload, null, 2)}\n`
  try {
    if ((await readFile(filePath, 'utf8')) === content) return
  } catch {}
  await writeJsonFile(filePath, payload)
}

const readOcrBlocks = async (ocrBlocksPath: string) => {
  if (!existsSync(ocrBlocksPath)) return []
  const parsed = JSON.parse(await readFile(ocrBlocksPath, 'utf8')) as unknown
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  if (isRecord(parsed) && Array.isArray(parsed.blocks)) {
    return parsed.blocks.filter(isRecord)
  }
  return []
}

const buildModuleOcrBlocks = async ({
  artifactDir,
  module,
}: {
  artifactDir: string
  module: SvgVerticalModule
}) => {
  const ocrBlocksPath = path.join(artifactDir, 'ocr-blocks.json')
  const moduleRegion = expandRegion(module.region)
  const moduleOcrIds = new Set(module.ocrBlockIds)
  const useExplicitOcrOwnership = module.kind === 'global-shell'
  const blocks = await readOcrBlocks(ocrBlocksPath)
  return blocks.flatMap((block) => {
    const id = isString(block.id) ? block.id : ''
    const bbox = getRegion(block.bbox)
    const belongsToModule =
      (id && moduleOcrIds.has(id)) ||
      (!useExplicitOcrOwnership && bbox ? intersects(bbox, moduleRegion) : false)
    if (!belongsToModule || !bbox) return []
    return [
      {
        ...block,
        bbox: {
          height: bbox.height,
          width: bbox.width,
          x: bbox.x - module.region.x,
          y: bbox.y - module.region.y,
        },
        moduleId: module.id,
        sourceBbox: bbox,
      },
    ]
  })
}

const writeHostModuleAllowedAssets = async ({
  artifactDir,
  module,
  moduleDir,
}: {
  artifactDir: string
  module: SvgVerticalModule
  moduleDir: string
}): Promise<ModuleAllowedAssetsResult> => {
  const allowedAssetsPath = path.join(moduleDir, 'allowed-assets.json')
  const moduleOcrBlocksPath = path.join(moduleDir, 'module-ocr-blocks.json')
  await writeJsonFileIfChanged(allowedAssetsPath, {
    assets: [],
    generatedBy: 'host-module-region',
    moduleId: module.id,
    readOnlyForAgent: true,
    region: module.region,
  })
  const ocrBlocks = await buildModuleOcrBlocks({ artifactDir, module }).catch(
    () => [],
  )
  await writeJsonFileIfChanged(moduleOcrBlocksPath, {
    blockCount: ocrBlocks.length,
    blocks: ocrBlocks,
    coordinateSpace: 'local',
    generatedBy: 'host-module-region',
    moduleId: module.id,
    region: module.region,
    sourceCoordinateSpace: 'absolute',
  })
  return {
    allowedAssetsPath,
    assetCount: 0,
    moduleOcrBlocksPath,
    ocrBlockCount: ocrBlocks.length,
  }
}

export { writeHostModuleAllowedAssets }
export type { ModuleAllowedAssetsResult }
