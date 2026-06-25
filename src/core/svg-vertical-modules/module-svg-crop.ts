import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { RootChildElement } from '../html-parse.js'
import {
  findTagEnd,
  parseRootChildElements,
} from '../html-parse.js'
import type { SvgSharedLayer, SvgVerticalModule } from './types.js'

type CropModuleSvgInput = {
  originalSvgPath: string
  originalSvgSource?: string
  module: SvgVerticalModule
  outputPath: string
  fallbackToOriginalWhenEmpty?: boolean
  scale?: number
}

type CropModuleSvgOutput = {
  moduleSvgPath: string
  prunedRootChildCount: number
  retainedRootChildCount: number
  viewBox: string
}

export const MODULE_SVG_CROP_VERSION = '6'

type SvgViewport = {
  height: number
  width: number
  x: number
  y: number
}

const readSvgAttribute = (attrs: string, name: string) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attrs.match(
    new RegExp(`(?:^|[\\s<])${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'i'),
  )
  return match?.[2]
}

const parseNumberList = (value?: string) =>
  (value ?? '')
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part))

const parseSvgLength = (value?: string) => {
  const match = (value ?? '').trim().match(/^[+-]?(?:\d+\.?\d*|\.\d+)/)
  if (!match?.[0]) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const parseSvgViewport = (attrs: string): SvgViewport | null => {
  const viewBoxParts = parseNumberList(readSvgAttribute(attrs, 'viewBox'))
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxParts
  if (
    viewBoxParts.length >= 4 &&
    viewBoxWidth !== undefined &&
    viewBoxHeight !== undefined &&
    viewBoxWidth > 0 &&
    viewBoxHeight > 0
  ) {
    return {
      x: viewBoxParts[0]!,
      y: viewBoxParts[1]!,
      width: viewBoxWidth,
      height: viewBoxHeight,
    }
  }

  const width = parseSvgLength(readSvgAttribute(attrs, 'width'))
  const height = parseSvgLength(readSvgAttribute(attrs, 'height'))
  if (!width || !height) return null
  return { x: 0, y: 0, width, height }
}

const inferRenderedSvgSize = ({
  attrs,
  scale,
  viewport,
}: {
  attrs: string
  scale: number
  viewport: SvgViewport
}) => {
  const viewBoxParts = parseNumberList(readSvgAttribute(attrs, 'viewBox'))
  const [, , viewBoxWidth, viewBoxHeight] = viewBoxParts
  if (
    viewBoxParts.length >= 4 &&
    viewBoxWidth !== undefined &&
    viewBoxHeight !== undefined &&
    viewBoxWidth > 0 &&
    viewBoxHeight > 0
  ) {
    return {
      height: viewBoxHeight * scale,
      width: viewBoxWidth * scale,
    }
  }

  const width = parseSvgLength(readSvgAttribute(attrs, 'width'))
  const height = parseSvgLength(readSvgAttribute(attrs, 'height'))
  return {
    height: (height ?? viewport.height) * scale,
    width: (width ?? viewport.width) * scale,
  }
}

const formatNumber = (value: number) => {
  const rounded = Number(value.toFixed(6))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

export const createModuleSvgCropFingerprint = ({
  module,
  originalSvg,
  scale = 1,
}: {
  module: SvgVerticalModule
  originalSvg: string
  scale?: number
}) =>
  sha256(
    JSON.stringify({
      moduleId: module.id,
      nodePaths: [...new Set(module.nodePaths)].sort(),
      region: module.region,
      scale,
      sourceHash: sha256(originalSvg),
      version: MODULE_SVG_CROP_VERSION,
    }),
  )

const parseSvgNumber = (value?: string) => {
  const match = (value ?? '')
    .trim()
    .match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)
  if (!match?.[0]) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

const readInlineStyleProperty = (openTag: string, name: string) => {
  const style = readSvgAttribute(openTag, 'style')
  if (!style) return undefined
  const normalizedName = name.trim().toLowerCase()
  for (const declaration of style.split(';')) {
    const separatorIndex = declaration.indexOf(':')
    if (separatorIndex === -1) continue
    const property = declaration.slice(0, separatorIndex).trim().toLowerCase()
    if (property !== normalizedName) continue
    return declaration.slice(separatorIndex + 1).trim()
  }
  return undefined
}

const readPresentationValue = (openTag: string, name: string) =>
  readSvgAttribute(openTag, name) ?? readInlineStyleProperty(openTag, name)

const readPresentationNumber = (openTag: string, name: string) =>
  parseSvgNumber(readPresentationValue(openTag, name))

const resolveSvgLength = ({
  fallback,
  reference,
  value,
}: {
  fallback: number
  reference: number
  value?: string
}) => {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return fallback
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1))
    return Number.isFinite(percent) ? (reference * percent) / 100 : fallback
  }
  return parseSvgNumber(trimmed) ?? fallback
}

const isHiddenElement = (openTag: string) => {
  const display = readSvgAttribute(openTag, 'display')?.trim().toLowerCase()
  const visibility = readSvgAttribute(openTag, 'visibility')
    ?.trim()
    .toLowerCase()
  const opacity = readPresentationNumber(openTag, 'opacity')
  return display === 'none' || visibility === 'hidden' || opacity === 0
}

const hasVisibleFill = (openTag: string) => {
  const fill = readPresentationValue(openTag, 'fill')?.trim().toLowerCase()
  const fillOpacity = readPresentationNumber(openTag, 'fill-opacity')
  return fill !== 'none' && fillOpacity !== 0
}

const isViewportBackgroundRect = (
  child: RootChildElement,
  viewport: SvgViewport,
) => {
  if (child.tag !== 'rect' || isHiddenElement(child.openTag)) return false
  if (!hasVisibleFill(child.openTag)) return false

  const x = resolveSvgLength({
    fallback: 0,
    reference: viewport.width,
    value: readSvgAttribute(child.openTag, 'x'),
  })
  const y = resolveSvgLength({
    fallback: 0,
    reference: viewport.height,
    value: readSvgAttribute(child.openTag, 'y'),
  })
  const width = resolveSvgLength({
    fallback: 0,
    reference: viewport.width,
    value: readSvgAttribute(child.openTag, 'width'),
  })
  const height = resolveSvgLength({
    fallback: 0,
    reference: viewport.height,
    value: readSvgAttribute(child.openTag, 'height'),
  })
  const tolerance = 0.5

  return (
    width > 0 &&
    height > 0 &&
    x <= viewport.x + tolerance &&
    y <= viewport.y + tolerance &&
    x + width >= viewport.x + viewport.width - tolerance &&
    y + height >= viewport.y + viewport.height - tolerance
  )
}

const isTransparentContainer = (child: RootChildElement) =>
  ['a', 'g', 'svg', 'switch'].includes(child.tag) &&
  !child.selfClosing &&
  !isHiddenElement(child.openTag)

const isIgnorableRootTag = (tag: string) =>
  ['desc', 'metadata', 'title'].includes(tag)

const LOW_VISUAL_OPACITY_THRESHOLD = 0.01

const SVG_RESOURCE_TAGS = new Set([
  'defs',
  'clippath',
  'filter',
  'lineargradient',
  'marker',
  'mask',
  'metadata',
  'pattern',
  'radialgradient',
  'style',
  'symbol',
])

const SVG_EMPTY_CONTAINER_TAGS = new Set(['a', 'g', 'svg', 'switch'])

const SVG_SHAPE_TAGS = new Set([
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
])

const isNoPaint = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'none' || normalized === 'transparent'
}

const hasNonNegligibleShapePaint = (openTag: string) => {
  const fill = readPresentationValue(openTag, 'fill')
  const stroke = readPresentationValue(openTag, 'stroke')
  const fillOpacity =
    readPresentationNumber(openTag, 'fill-opacity') ?? 1
  const strokeOpacity =
    readPresentationNumber(openTag, 'stroke-opacity') ?? 1

  const fillCanPaint = !isNoPaint(fill)
  const strokeCanPaint = Boolean(stroke) && !isNoPaint(stroke)

  return (
    (fillCanPaint && fillOpacity > LOW_VISUAL_OPACITY_THRESHOLD) ||
    (strokeCanPaint && strokeOpacity > LOW_VISUAL_OPACITY_THRESHOLD)
  )
}

const hasNegligibleOpacity = (child: RootChildElement) => {
  if (SVG_RESOURCE_TAGS.has(child.tag)) return false
  const opacity = readPresentationNumber(child.openTag, 'opacity')
  if (opacity !== null && opacity <= LOW_VISUAL_OPACITY_THRESHOLD) return true
  return (
    SVG_SHAPE_TAGS.has(child.tag) &&
    !hasNonNegligibleShapePaint(child.openTag)
  )
}

const removeNegligibleOpacityContent = (content: string): string => {
  const children = parseRootChildElements(content)
  if (!children.length) return content

  return children
    .flatMap((child): string[] => {
      if (hasNegligibleOpacity(child)) return []
      if (child.selfClosing || SVG_RESOURCE_TAGS.has(child.tag)) {
        return [child.content]
      }

      const innerContent = removeNegligibleOpacityContent(child.innerContent)
      if (!innerContent.trim() && SVG_EMPTY_CONTAINER_TAGS.has(child.tag)) {
        return []
      }
      return [`${child.openTag}\n${innerContent}\n${child.closeTag}`]
    })
    .join('\n')
}

const extractLeadingViewportBackgroundContent = ({
  content,
  viewport,
}: {
  content: string
  viewport: SvgViewport
}): string => {
  const retained: string[] = []
  const children = parseRootChildElements(content)

  for (const child of children) {
    if (isIgnorableRootTag(child.tag)) continue

    if (isViewportBackgroundRect(child, viewport)) {
      retained.push(child.content)
      continue
    }

    if (isTransparentContainer(child)) {
      const innerBackgrounds = extractLeadingViewportBackgroundContent({
        content: child.innerContent,
        viewport,
      })
      if (innerBackgrounds.trim()) {
        retained.push(`${child.openTag}\n${innerBackgrounds}\n${child.closeTag}`)
      }
    }

    break
  }

  return retained.join('\n')
}

const getRelevantNodePaths = (nodePaths: string[]) => {
  const paths = new Set<string>()
  let keepAll = nodePaths.length === 0

  for (const nodePath of nodePaths) {
    const normalized = nodePath
      .split(' > ')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .join(' > ')
    if (!normalized || normalized === 'svg:nth-of-type(1)') {
      keepAll = true
      continue
    }
    paths.add(normalized)
  }

  return { keepAll, paths }
}

const filterContentByNodePaths = ({
  content,
  parentPath,
  paths,
}: {
  content: string
  parentPath: string
  paths: Set<string>
}): string => {
  const children = parseRootChildElements(content)
  const retained: string[] = children.flatMap((child): string[] => {
    const childPath = `${parentPath} > ${child.pathSegment}`
    const relevantPaths = [...paths].filter(
      (nodePath) =>
        nodePath === childPath || nodePath.startsWith(`${childPath} > `),
    )
    if (!relevantPaths.length) return []
    if (relevantPaths.includes(childPath) || child.selfClosing) {
      return [child.content]
    }

    const filteredInner: string = filterContentByNodePaths({
      content: child.innerContent,
      parentPath: childPath,
      paths,
    })

    return filteredInner.trim()
      ? [`${child.openTag}\n${filteredInner}\n${child.closeTag}`]
      : []
  })

  return retained.join('\n')
}

const filterSvgContentToModuleRootChildren = ({
  content,
  fallbackToOriginalWhenEmpty = true,
  nodePaths,
}: {
  content: string
  fallbackToOriginalWhenEmpty?: boolean
  nodePaths: string[]
}) => {
  const { keepAll, paths } = getRelevantNodePaths(nodePaths)
  if (keepAll || paths.size === 0) {
    return {
      content,
      prunedRootChildCount: 0,
      retainedRootChildCount: parseRootChildElements(content).length,
    }
  }

  const children = parseRootChildElements(content)
  const filteredContent = filterContentByNodePaths({
    content,
    parentPath: 'svg:nth-of-type(1)',
    paths,
  })
  const retainedRootChildCount = parseRootChildElements(filteredContent).length

  if (!filteredContent.trim()) {
    return {
      content: fallbackToOriginalWhenEmpty ? content : '',
      prunedRootChildCount: fallbackToOriginalWhenEmpty ? 0 : children.length,
      retainedRootChildCount: fallbackToOriginalWhenEmpty ? children.length : 0,
    }
  }

  return {
    content: filteredContent,
    prunedRootChildCount: Math.max(0, children.length - retainedRootChildCount),
    retainedRootChildCount,
  }
}

const filterSvgContentToModuleSubtrees = ({
  content,
  fallbackToOriginalWhenEmpty = true,
  nodePaths,
}: {
  content: string
  fallbackToOriginalWhenEmpty?: boolean
  nodePaths: string[]
}) => {
  const filtered = filterSvgContentToModuleRootChildren({
    content,
    fallbackToOriginalWhenEmpty,
    nodePaths,
  })
  return {
    ...filtered,
    content:
      filtered.content.trim() || !fallbackToOriginalWhenEmpty
        ? filtered.content
        : content,
  }
}

const countRootChildren = (content: string) =>
  parseRootChildElements(content).length

const summarizeNoFilter = (content: string) => ({
  content,
  prunedRootChildCount: 0,
  retainedRootChildCount: countRootChildren(content),
})

const filterSvgContentToModule = ({
  content,
  fallbackToOriginalWhenEmpty = true,
  nodePaths,
}: {
  content: string
  fallbackToOriginalWhenEmpty?: boolean
  nodePaths: string[]
}) => {
  if (!nodePaths.length) {
    return fallbackToOriginalWhenEmpty
      ? summarizeNoFilter(content)
      : {
          content: '',
          prunedRootChildCount: countRootChildren(content),
          retainedRootChildCount: 0,
        }
  }
  const filtered = filterSvgContentToModuleSubtrees({
    content,
    fallbackToOriginalWhenEmpty,
    nodePaths,
  })
  if (!filtered.content.trim() && fallbackToOriginalWhenEmpty) {
    return summarizeNoFilter(content)
  }
  return filtered
}

const removeBlocks = (svgInnerContent: string, blocks: string[]) =>
  blocks.reduce(
    (content, block) => content.replace(block, ''),
    svgInnerContent,
  )

const removeDefsBlocks = removeBlocks

const extractReferencedIds = (content: string) => {
  const ids = new Set<string>()
  const patterns = [
    /url\(\s*#([^'")\s]+)\s*\)/g,
    /\b(?:href|xlink:href)\s*=\s*(["'])#([^"']+)\1/g,
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const id = match[2] ?? match[1]
      if (id) ids.add(id)
    }
  }
  return ids
}

const extractElementIds = (content: string) =>
  [...content.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/g)].map(
    (match) => match[2]!,
  )

const getDefsInnerContent = (defsBlock: string) => {
  const match = defsBlock.match(/<defs\b[^>]*>([\s\S]*)<\/defs>\s*$/i)
  return match?.[1] ?? ''
}

const filterDefsBlocksToReferences = ({
  defsBlocks,
  content,
}: {
  defsBlocks: string[]
  content: string
}) => {
  if (!defsBlocks.length) return ''
  const defsChildren = defsBlocks.flatMap((defsBlock) =>
    parseRootChildElements(getDefsInnerContent(defsBlock)),
  )
  if (!defsChildren.length) return ''

  const referencedIds = extractReferencedIds(content)
  const alwaysKeepTags = new Set(['style'])
  const retained = new Set<RootChildElement>()
  let changed = true

  while (changed) {
    changed = false
    for (const child of defsChildren) {
      const childIds = extractElementIds(child.openTag)
      const nestedIds = extractElementIds(child.content)
      const shouldKeep =
        alwaysKeepTags.has(child.tag) ||
        childIds.some((id) => referencedIds.has(id)) ||
        nestedIds.some((id) => referencedIds.has(id))
      if (!shouldKeep || retained.has(child)) continue
      retained.add(child)
      changed = true
      extractReferencedIds(child.content).forEach((id) => referencedIds.add(id))
    }
  }

  const retainedContent = defsChildren
    .filter((child) => retained.has(child))
    .map((child) => child.content)
    .join('\n')
    .trim()

  return retainedContent ? `<defs>\n${retainedContent}\n</defs>` : ''
}

const BODY_DEFINITION_TAGS = new Set([
  'clippath',
  'filter',
  'lineargradient',
  'marker',
  'mask',
  'pattern',
  'radialgradient',
  'symbol',
])

const parseDefinitionElementsDeep = (content: string) => {
  const definitions: RootChildElement[] = []
  const tagCounts = new Map<string, number>()

  for (const tag of BODY_DEFINITION_TAGS) {
    const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi')
    for (const match of content.matchAll(pattern)) {
      const rawElement = match[0]
      const openEnd = findTagEnd(rawElement, 0)
      if (openEnd === -1) continue
      const openTag = rawElement.slice(0, openEnd + 1)
      if (extractElementIds(openTag).length === 0) continue
      const closeStart = rawElement.toLowerCase().lastIndexOf(`</${tag}`)
      const innerContent =
        closeStart >= 0 ? rawElement.slice(openTag.length, closeStart) : ''
      const closeTag = closeStart >= 0 ? rawElement.slice(closeStart) : ''
      const nthOfType = (tagCounts.get(tag) ?? 0) + 1
      tagCounts.set(tag, nthOfType)
      definitions.push({
        closeTag,
        content: rawElement,
        innerContent,
        nthOfType,
        openTag,
        pathSegment: `${tag}:nth-of-type(${nthOfType})`,
        selfClosing: false,
        tag,
      })
    }
  }

  return definitions
}

const collectReferencedBodyDefinitions = ({
  content,
  referencedContent,
}: {
  content: string
  referencedContent: string
}) => {
  const definitionChildren = parseDefinitionElementsDeep(content)
  if (!definitionChildren.length) return ''

  const referencedIds = extractReferencedIds(referencedContent)
  const retained = new Set<RootChildElement>()
  let changed = true

  while (changed) {
    changed = false
    for (const child of definitionChildren) {
      const childIds = extractElementIds(child.openTag)
      const shouldKeep = childIds.some((id) => referencedIds.has(id))
      if (!shouldKeep || retained.has(child)) continue
      retained.add(child)
      changed = true
      extractReferencedIds(child.content).forEach((id) => referencedIds.add(id))
    }
  }

  return definitionChildren
    .filter((child) => retained.has(child))
    .map((child) => child.content)
    .join('\n')
}

/**
 * 为单个模块生成裁切后的 SVG 文件
 *
 * 策略：
 * - 保留原 SVG 的 <defs>、namespace、字体引用等
 * - 用 <g transform="translate(...)"> 包裹内容，平移到模块源坐标 (0,0)
 * - 以源 SVG 坐标写出 viewBox，让后续渲染得到模块 region 像素尺寸
 * - N=1 时 region 覆盖整图，偏移为 0，等效于复制原图
 */
export async function cropModuleSvg(
  input: CropModuleSvgInput,
): Promise<CropModuleSvgOutput> {
  const {
    fallbackToOriginalWhenEmpty = true,
    originalSvgPath,
    originalSvgSource,
    module,
    outputPath,
    scale = 1,
  } = input
  const { region } = module

  // 读取原始 SVG
  const originalSvg = originalSvgSource ?? (await readFile(originalSvgPath, 'utf8'))

  // 提取 <svg> 开始标签（含所有属性）
  const svgOpenMatch = originalSvg.match(/<svg\b([^>]*)>/i)
  if (!svgOpenMatch) {
    throw new Error(`Invalid SVG: no <svg> tag found in ${originalSvgPath}`)
  }

  const originalSvgAttrs = svgOpenMatch[1] ?? ''

  // 提取 <svg> 和 </svg> 之间的内容
  const svgContentMatch = originalSvg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i)
  if (!svgContentMatch || !svgContentMatch[1]) {
    throw new Error(`Invalid SVG: no closing </svg> tag in ${originalSvgPath}`)
  }

  const svgInnerContent = svgContentMatch[1]

  // 分离 <defs> 和其他内容；<defs> 需要保留在 transform 外部（全局定义）。
  const defsBlocks = [...svgInnerContent.matchAll(/<defs\b[\s\S]*?<\/defs>/gi)]
    .map((match) => match[0])
    .filter(Boolean)
  const contentWithoutDefs = removeDefsBlocks(svgInnerContent, defsBlocks)
  const rootStyleBlocks = [
    ...contentWithoutDefs.matchAll(/<style\b[\s\S]*?<\/style>/gi),
  ]
    .map((match) => match[0])
    .filter(Boolean)
  const contentWithoutDefinitions = removeBlocks(
    contentWithoutDefs,
    rootStyleBlocks,
  )
  const effectiveFallbackToOriginalWhenEmpty =
    module.nodePaths.length > 0
      ? fallbackToOriginalWhenEmpty
      : module.kind === 'single-page'
  const filteredContent = filterSvgContentToModule({
    content: contentWithoutDefinitions,
    fallbackToOriginalWhenEmpty: effectiveFallbackToOriginalWhenEmpty,
    nodePaths: module.nodePaths,
  })
  const originalViewport = parseSvgViewport(originalSvgAttrs) ?? {
    x: 0,
    y: 0,
    width: region.width,
    height: region.height,
  }
  // Module regions are planned in rendered pixels. The source SVG may be
  // authored at a different scale, and parseSvgSize applies the configured
  // scale factor. Crop in source units so local module verify keeps the same
  // pixel size as the HTML preview.
  const renderedViewport = inferRenderedSvgSize({
    attrs: originalSvgAttrs,
    scale,
    viewport: originalViewport,
  })
  const renderScaleX =
    originalViewport.width > 0 ? renderedViewport.width / originalViewport.width : 1
  const renderScaleY =
    originalViewport.height > 0 ? renderedViewport.height / originalViewport.height : 1
  const safeScaleX =
    Number.isFinite(renderScaleX) && renderScaleX > 0 ? renderScaleX : 1
  const safeScaleY =
    Number.isFinite(renderScaleY) && renderScaleY > 0 ? renderScaleY : 1
  const sourceRegion = {
    x: originalViewport.x + region.x / safeScaleX,
    y: originalViewport.y + region.y / safeScaleY,
    width: region.width / safeScaleX,
    height: region.height / safeScaleY,
  }
  const shellBackgroundContent =
    module.kind === 'global-shell' && !filteredContent.content.trim()
      ? extractLeadingViewportBackgroundContent({
          content: contentWithoutDefinitions,
          viewport: sourceRegion,
        })
      : ''
  const ownedContentBeforePrune = filteredContent.content.trim()
    ? filteredContent.content
    : shellBackgroundContent
  const ownedContent = removeNegligibleOpacityContent(ownedContentBeforePrune)
  const bodyDefinitions = collectReferencedBodyDefinitions({
    content: contentWithoutDefinitions,
    referencedContent: [ownedContent].filter((part) => part.trim()).join('\n'),
  })
  const moduleContent = [bodyDefinitions, ownedContent]
    .filter((part) => part.trim())
    .join('\n')
  const defs = filterDefsBlocksToReferences({
    content: moduleContent,
    defsBlocks,
  })

  // 构造源坐标系下的局部 viewBox
  const viewBox = `0 0 ${formatNumber(sourceRegion.width)} ${formatNumber(sourceRegion.height)}`

  // 计算平移偏移（把源 SVG 坐标平移到局部 0,0）
  const translateX = -sourceRegion.x
  const translateY = -sourceRegion.y

  // 构造裁切后的 SVG。
  // 保留原 SVG 的 namespace 和其他属性，覆盖 viewport 相关属性。
  const cleanedAttrs = (originalSvgAttrs ?? '').replace(
    /\s+(?:width|height|viewBox|overflow)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  )

  const fingerprint = createModuleSvgCropFingerprint({ module, originalSvg, scale })
  const globalDefinitions = [defs, ...rootStyleBlocks]
    .filter((part) => part.trim())
    .join('\n')
  const croppedSvg = `<svg${cleanedAttrs} width="${formatNumber(region.width)}" height="${formatNumber(region.height)}" viewBox="${viewBox}" overflow="hidden" data-module-crop-version="${MODULE_SVG_CROP_VERSION}" data-module-crop-fingerprint="${fingerprint}">
${globalDefinitions}
  <g transform="translate(${formatNumber(translateX)}, ${formatNumber(translateY)})">
${moduleContent}
  </g>
</svg>
`

  // 写入输出文件
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, croppedSvg, 'utf8')

  return {
    moduleSvgPath: outputPath,
    prunedRootChildCount: filteredContent.prunedRootChildCount,
    retainedRootChildCount: filteredContent.retainedRootChildCount,
    viewBox,
  }
}

async function cropSharedLayerSvg(input: {
  originalSvgPath: string
  originalSvgSource?: string
  outputPath: string
  scale?: number
  sharedLayer: SvgSharedLayer
}): Promise<CropModuleSvgOutput> {
  const { originalSvgPath, originalSvgSource, outputPath, scale, sharedLayer } =
    input
  return cropModuleSvg({
    fallbackToOriginalWhenEmpty: false,
    originalSvgPath,
    originalSvgSource,
    outputPath,
    scale,
    module: {
      candidateNodeCount: sharedLayer.nodePaths.length,
      contentBox: sharedLayer.contentBox,
      diffRegion: sharedLayer.region,
      id: sharedLayer.id,
      kind: 'model-region',
      nodePaths: sharedLayer.nodePaths,
      reason: sharedLayer.reason,
      region: sharedLayer.region,
      score: 0,
      sourceContainerIds: [],
    },
  })
}

/**
 * 批量为所有模块生成裁切 SVG
 */
export async function cropAllModuleSvgs(input: {
  originalSvgPath: string
  modules: SvgVerticalModule[]
  modulesRootDir: string
  scale?: number
  sharedLayers?: SvgSharedLayer[]
}): Promise<Map<string, CropModuleSvgOutput>> {
  const { originalSvgPath, modules, modulesRootDir, scale, sharedLayers = [] } =
    input
  const results = new Map<string, CropModuleSvgOutput>()

  for (const module of modules) {
    const outputPath = path.join(modulesRootDir, module.id, 'module.svg')
    const result = await cropModuleSvg({
      originalSvgPath,
      module,
      outputPath,
      scale,
    })
    results.set(module.id, result)
  }

  for (const sharedLayer of sharedLayers) {
    const outputPath =
      sharedLayer.svgPath ?? path.join(modulesRootDir, `${sharedLayer.id}.svg`)
    const result = await cropSharedLayerSvg({
      originalSvgPath,
      outputPath,
      scale,
      sharedLayer,
    })
    results.set(sharedLayer.id, result)
  }

  return results
}
