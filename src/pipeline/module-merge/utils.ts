import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getWorkspaceRoot, isRecord, toAbsolutePath, type Region } from '../../core/utils.js'

const isString = (value: unknown): value is string => typeof value === 'string'

const asString = (value: unknown) => (isString(value) ? value : undefined)

const normalizePathForCompare = (value: string) =>
  path.resolve(value).replaceAll(path.sep, '/').toLowerCase()

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const unique = <T>(items: T[]) => [...new Set(items)]

const formatPx = (value: number) => `${Math.round(value)}px`

const formatRegionStyle = (region: Region) =>
  [
    'position:absolute',
    `left:${formatPx(region.x)}`,
    `top:${formatPx(region.y)}`,
    `width:${formatPx(region.width)}`,
    `height:${formatPx(region.height)}`,
    'overflow:hidden',
  ].join(';')

const indent = (content: string, spaces: number) => {
  const prefix = ' '.repeat(spaces)
  return content
    .trim()
    .split('\n')
    .map((line) => `${prefix}${line}`.trimEnd())
    .join('\n')
}

const parseJsonFile = async <T>(filePath: string, label: string): Promise<T> => {
  const raw = await readFile(filePath, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(
      `Unable to parse ${label} as JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

const readRequiredText = async (filePath: string, label: string) => {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(
      `${label} not found: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

const resolveConfiguredPath = (value: string, baseDir: string) => {
  if (path.isAbsolute(value)) return path.normalize(value)

  const workspaceBaseName = path.basename(getWorkspaceRoot())
  if (
    value === workspaceBaseName ||
    value.startsWith(`${workspaceBaseName}/`) ||
    value.startsWith(`${workspaceBaseName}\\`)
  ) {
    return toAbsolutePath(value)
  }

  if (value.startsWith('./') || value.startsWith('../')) {
    return path.resolve(baseDir, value)
  }

  return path.resolve(baseDir, value)
}

const toNumber = (value: unknown, label: string) => {
  const numberValue = Number(value)
  if (Number.isFinite(numberValue)) return numberValue
  throw new Error(`Invalid numeric value for ${label}: ${String(value)}`)
}

const normalizeRegion = (value: unknown, label: string): Region => {
  if (!isRecord(value)) throw new Error(`${label} is missing region`)
  return {
    height: toNumber(value.height, `${label}.height`),
    id: asString(value.id),
    width: toNumber(value.width, `${label}.width`),
    x: toNumber(value.x, `${label}.x`),
    y: toNumber(value.y, `${label}.y`),
  }
}

export {
  asString,
  escapeRegExp,
  formatPx,
  formatRegionStyle,
  indent,
  isRecord,
  isString,
  normalizePathForCompare,
  normalizeRegion,
  parseJsonFile,
  readRequiredText,
  resolveConfiguredPath,
  unique,
}
