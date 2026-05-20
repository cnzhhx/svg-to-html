import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { DesignPair } from '../../core/utils.js'
import { writeJsonFile, writeTextFile } from '../../core/utils.js'
import { verifyDesign } from '../verify.js'
import type { VerifyResult } from '../verify/types.js'

type OutputFormat = 'html' | 'react' | 'vue'
type FrameworkExportTarget = 'react' | 'vue'

type FrameworkExportStatus = 'completed' | 'failed' | 'skipped'

type FrameworkExportAsset = {
  copiedPath: string
  originalPath: string
  originalRef: string
  ref: string
}

type FrameworkExportRecord = {
  assetManifestPath?: string
  assets?: FrameworkExportAsset[]
  componentPaths?: string[]
  cssPath?: string
  dir: string
  error?: string
  previewHtmlPath?: string
  repeatComponentCount?: number
  status: FrameworkExportStatus
  target: FrameworkExportTarget
  verifyResult?: VerifyResult
}

type ExportFrameworkTargetsInput = {
  artifactDir: string
  design: DesignPair
  formats: OutputFormat[]
  onProgress?: (message: string) => void
  regionsPath?: string
  runVerify?: boolean
}

type ModuleSection = {
  className: string
  id: string
  innerHtml: string
  startTag: string
  style: string
}

type SharedLayer = {
  className: string
  id: string
  innerHtml: string
  kind: string
  src: string
  style: string
}

type PageModel = {
  css: string
  designPageInner: string
  designPageOpenTag: string
  html: string
  modules: ModuleSection[]
  sharedLayers: SharedLayer[]
}

type ElementSegment = {
  end: number
  innerHtml: string
  segment: string
  start: number
  startTag: string
  tagName: string
}

type RepeatExtraction = {
  componentName: string
  dataName: string
  itemComponentHtml: string
  items: Array<Record<string, unknown>>
  paths: {
    react?: string
    vue?: string
  }
}

const FRAMEWORK_TARGETS = new Set<FrameworkExportTarget>(['react', 'vue'])
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const LOCAL_ASSET_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.ttc',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
])

const HTML_REF_RE =
  /\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1|\bsrcset\s*=\s*(["'])(.*?)\3|url\(\s*(["']?)([^'")]+)\5\s*\)/gi

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const upperFirst = (value: string) =>
  value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value

const toComponentName = (id: string) =>
  (id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => upperFirst(part))
    .join('') || 'DesignModule'
  ).replace(/^(\d)/, 'Component$1')

const toIdentifier = (value: string) => {
  const next = toComponentName(value)
  return `${next[0]?.toLowerCase() ?? 'x'}${next.slice(1)}`
}

const indent = (value: string, spaces: number) => {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => (line ? `${padding}${line}` : line))
    .join('\n')
}

const getAttr = (tag: string, name: string) => {
  const match = tag.match(
    new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, 'i'),
  )
  return match?.[2] ?? ''
}

const hasClass = (tag: string, className: string) =>
  getAttr(tag, 'class').split(/\s+/).includes(className)

const findClosingTagEnd = (html: string, startTagEnd: number, tagName: string) => {
  const tagPattern = new RegExp(`</?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi')
  tagPattern.lastIndex = startTagEnd
  let depth = 1
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0]
    if (tag.startsWith('</')) {
      depth -= 1
      if (depth === 0) return (match.index ?? 0) + tag.length
    } else if (!tag.endsWith('/>') && !VOID_TAGS.has(tagName.toLowerCase())) {
      depth += 1
    }
  }
  return -1
}

const splitElementSegment = (segment: string): ElementSegment | null => {
  const open = segment.match(/^<([a-z][\w:-]*)\b[^>]*>/i)
  if (!open?.[0] || !open[1]) return null
  const tagName = open[1].toLowerCase()
  if (VOID_TAGS.has(tagName) || open[0].endsWith('/>')) {
    return {
      end: segment.length,
      innerHtml: '',
      segment,
      start: 0,
      startTag: open[0],
      tagName,
    }
  }
  const closePattern = new RegExp(`</${escapeRegExp(tagName)}\\s*>\\s*$`, 'i')
  const close = segment.match(closePattern)
  if (!close?.[0]) return null
  return {
    end: segment.length,
    innerHtml: segment.slice(open[0].length, segment.length - close[0].length),
    segment,
    start: 0,
    startTag: open[0],
    tagName,
  }
}

const findTopLevelElements = (html: string) => {
  const elements: ElementSegment[] = []
  const openPattern = /<([a-z][\w:-]*)\b[^>]*>/gi
  let searchIndex = 0

  while (searchIndex < html.length) {
    openPattern.lastIndex = searchIndex
    const match = openPattern.exec(html)
    if (!match?.[0] || !match[1]) break
    const prefix = html.slice(searchIndex, match.index)
    if (prefix.trim() && elements.length) break
    const tagName = match[1].toLowerCase()
    const startTag = match[0]
    const start = match.index
    const startTagEnd = start + startTag.length
    const end =
      VOID_TAGS.has(tagName) || startTag.endsWith('/>')
        ? startTagEnd
        : findClosingTagEnd(html, startTagEnd, tagName)
    if (end < 0) break
    const segment = html.slice(start, end)
    elements.push({
      end,
      innerHtml:
        VOID_TAGS.has(tagName) || startTag.endsWith('/>')
          ? ''
          : splitElementSegment(segment)?.innerHtml ?? '',
      segment,
      start,
      startTag,
      tagName,
    })
    searchIndex = end
  }

  return elements
}

const extractStyleCss = (html: string) => {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
  return `${blocks.join('\n\n')}\n`
}

const findElementsByTag = (html: string, tagName: string) => {
  const results: ElementSegment[] = []
  const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, 'gi')
  for (const match of html.matchAll(pattern)) {
    const startTag = match[0]
    const start = match.index ?? 0
    const startTagEnd = start + startTag.length
    const end = findClosingTagEnd(html, startTagEnd, tagName)
    if (end < 0) continue
    const segment = html.slice(start, end)
    results.push({
      end,
      innerHtml: splitElementSegment(segment)?.innerHtml ?? '',
      segment,
      start,
      startTag,
      tagName,
    })
  }
  return results
}

const findDesignPage = (html: string) => {
  const page = findElementsByTag(html, 'main').find((element) =>
    hasClass(element.startTag, 'design-page'),
  )
  if (!page) throw new Error('Unable to locate <main class="design-page">')
  return page
}

const extractImageSource = (html: string) => {
  const match = html.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)
  return match?.[2] ?? ''
}

const buildPageModel = async (htmlPath: string): Promise<PageModel> => {
  const html = await readFile(htmlPath, 'utf8')
  const designPage = findDesignPage(html)
  const pageElements = findTopLevelElements(designPage.innerHtml)
  const modules: ModuleSection[] = []
  const sharedLayers: SharedLayer[] = []

  pageElements.forEach((element) => {
    if (hasClass(element.startTag, 'design-module')) {
      const id = getAttr(element.startTag, 'data-module-id')
      if (!id) return
      modules.push({
        className: getAttr(element.startTag, 'class'),
        id,
        innerHtml: element.innerHtml,
        startTag: element.startTag,
        style: getAttr(element.startTag, 'style'),
      })
      return
    }

    if (hasClass(element.startTag, 'shared-design-layer')) {
      const id = getAttr(element.startTag, 'data-shared-layer-id')
      sharedLayers.push({
        className: getAttr(element.startTag, 'class'),
        id,
        innerHtml: element.innerHtml,
        kind: getAttr(element.startTag, 'data-shared-layer-kind'),
        src: extractImageSource(element.innerHtml),
        style: getAttr(element.startTag, 'style'),
      })
    }
  })

  return {
    css: extractStyleCss(html),
    designPageInner: designPage.innerHtml,
    designPageOpenTag: designPage.startTag,
    html,
    modules,
    sharedLayers,
  }
}

const splitReference = (ref: string) => {
  const suffixIndex = ref.search(/[?#]/)
  return suffixIndex >= 0
    ? { clean: ref.slice(0, suffixIndex), suffix: ref.slice(suffixIndex) }
    : { clean: ref, suffix: '' }
}

const isExternalRef = (ref: string) =>
  !ref ||
  ref.startsWith('#') ||
  ref.startsWith('/') ||
  /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(ref) ||
  /^(?:data|blob|javascript):/i.test(ref)

const collectLocalRefs = (content: string) => {
  const refs = new Set<string>()
  for (const match of content.matchAll(HTML_REF_RE)) {
    const attrRef = match[2] ?? match[4] ?? match[6] ?? ''
    if (!attrRef) continue
    if (match[4]) {
      for (const part of attrRef.split(',')) {
        const candidate = part.trim().split(/\s+/, 1)[0] ?? ''
        if (!isExternalRef(candidate)) refs.add(candidate)
      }
      continue
    }
    if (!isExternalRef(attrRef)) refs.add(attrRef)
  }
  return [...refs]
}

const safeFileName = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'

const copyReferencedAssets = async ({
  exportDir,
  htmlDir,
  refs,
}: {
  exportDir: string
  htmlDir: string
  refs: string[]
}) => {
  const assetsDir = path.join(exportDir, 'assets')
  await mkdir(assetsDir, { recursive: true })
  const byCleanRef = new Map<string, FrameworkExportAsset>()
  const replacements = new Map<string, string>()

  for (const ref of refs) {
    const { clean, suffix } = splitReference(ref)
    const ext = path.extname(clean).toLowerCase()
    if (!LOCAL_ASSET_EXTENSIONS.has(ext)) continue
    const originalPath = path.resolve(htmlDir, clean)
    if (!existsSync(originalPath)) continue

    let asset = byCleanRef.get(clean)
    if (!asset) {
      const hash = createHash('sha1').update(originalPath).digest('hex').slice(0, 8)
      const parsed = path.parse(clean)
      const fileName = `${safeFileName(parsed.name)}-${hash}${parsed.ext}`
      const copiedPath = path.join(assetsDir, fileName)
      await copyFile(originalPath, copiedPath)
      asset = {
        copiedPath,
        originalPath,
        originalRef: clean,
        ref: `./assets/${fileName}`,
      }
      byCleanRef.set(clean, asset)
    }
    replacements.set(ref, `${asset.ref}${suffix}`)
  }

  return {
    assets: [...byCleanRef.values()],
    replacements,
  }
}

const replaceRefs = (content: string, replacements: Map<string, string>) => {
  let next = content
  const ordered = [...replacements.entries()].sort(
    ([left], [right]) => right.length - left.length,
  )
  for (const [from, to] of ordered) {
    next = next.replaceAll(from, to)
  }
  return next
}

const cssPropName = (name: string) => {
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('--')) return trimmed
  return trimmed.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  )
}

const parseStyleObject = (style: string) => {
  const entries: Record<string, string> = {}
  style
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((declaration) => {
      const colon = declaration.indexOf(':')
      if (colon <= 0) return
      entries[cssPropName(declaration.slice(0, colon))] = declaration
        .slice(colon + 1)
        .trim()
    })
  return entries
}

const renderObjectLiteral = (value: unknown, level = 0): string => {
  const pad = ' '.repeat(level)
  const nextPad = ' '.repeat(level + 2)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return `[\n${value.map((item) => `${nextPad}${renderObjectLiteral(item, level + 2)}`).join(',\n')},\n${pad}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return '{}'
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${nextPad}${JSON.stringify(key)}: ${renderObjectLiteral(item, level + 2)}`,
      )
      .join(',\n')},\n${pad}}`
  }
  return JSON.stringify(value)
}

const renderStyleObjectExpression = (style: string) =>
  renderObjectLiteral(parseStyleObject(style))

const styleStringToJsx = (style: string) =>
  `style={${renderStyleObjectExpression(style)}}`

const htmlToJsx = (html: string) => {
  let next = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\bclass\s*=/gi, 'className=')
    .replace(/\bfor\s*=/gi, 'htmlFor=')
    .replace(/\btabindex\s*=/gi, 'tabIndex=')
    .replace(/\bmaxlength\s*=/gi, 'maxLength=')
    .replace(/\breadonly\s*=/gi, 'readOnly=')
    .replace(/\bcolspan\s*=/gi, 'colSpan=')
    .replace(/\browspan\s*=/gi, 'rowSpan=')
    .replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (_match, _quote, style) =>
      styleStringToJsx(style),
    )

  next = next.replace(
    new RegExp(`<(${[...VOID_TAGS].join('|')})([^>/]*?)>`, 'gi'),
    (_match, tag: string, attrs: string) => `<${tag}${attrs} />`,
  )
  next = next.replace(/\sdata-item-style-marker=(["'])true\1/g, ' style={item.style}')
  next = next.replace(/"__REF_(\d+)__"/g, '{item.ref$1}')
  next = next.replace(/__TEXT_(\d+)__/g, '{item.text$1}')
  return next
}

const htmlToVueTemplate = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sdata-item-style-marker=(["'])true\1/g, ' :style="item.style"')
    .replace(/(["'])__REF_(\d+)__\1/g, (_match, _quote, index) => `"__REF_${index}__"`)
    .replace(/\b(src|href|poster)=["']__REF_(\d+)__["']/g, (_match, attr, index) => `:${attr}="item.ref${index}"`)
    .replace(/__TEXT_(\d+)__/g, (_match, index) => `{{ item.text${index} }}`)

const collectTextParts = (html: string) =>
  [...html.matchAll(/>([^<>{}][^<>]*?)</g)]
    .map((match) => match[1] ?? '')
    .filter((text) => text.trim().length > 0)

const collectRefValues = (html: string) =>
  [...html.matchAll(/\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi)].map((match) => ({
    attr: match[1] ?? '',
    value: match[3] ?? '',
  }))

const structuralSignature = (segment: string) =>
  segment
    .replace(/\bid\s*=\s*(["']).*?\1/gi, 'id=""')
    .replace(/\b(?:src|href|poster)\s*=\s*(["']).*?\1/gi, (_match) => 'ref=""')
    .replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (_match, _quote, style) => {
      const stable = style
        .split(';')
        .map((item: string) => item.trim())
        .filter(Boolean)
        .filter((item: string) => !/^(?:left|top|right|bottom)\s*:/i.test(item))
        .join(';')
      return `style="${stable}"`
    })
    .replace(/>[^<]+</g, '>#<')
    .replace(/\s+/g, ' ')
    .trim()

const canUseRepeatSegment = (segment: string) =>
  !/\bid\s*=/i.test(segment) &&
  !/<(?:script|style|svg|canvas)\b/i.test(segment) &&
  !/\bdata-module-id\s*=/i.test(segment)

const findRepeatGroup = (html: string) => {
  const children = findTopLevelElements(html).filter((child) =>
    canUseRepeatSegment(child.segment),
  )
  if (children.length < 3) return null

  for (let index = 0; index <= children.length - 3; index += 1) {
    const signature = structuralSignature(children[index]!.segment)
    let end = index + 1
    while (
      end < children.length &&
      structuralSignature(children[end]!.segment) === signature
    ) {
      end += 1
    }
    if (end - index >= 3 && index === 0 && end === children.length) {
      const group = children.slice(index, end)
      const textCount = collectTextParts(group[0]!.segment).length
      const refCount = collectRefValues(group[0]!.segment).length
      const stable = group.every(
        (item) =>
          collectTextParts(item.segment).length === textCount &&
          collectRefValues(item.segment).length === refCount,
      )
      if (stable) return group
    }
  }

  return null
}

const replaceFirstRootStyleWithMarker = (segment: string) => {
  const open = segment.match(/^<([a-z][\w:-]*)\b[^>]*>/i)
  if (!open?.[0]) return segment
  const startTag = open[0]
  const withoutStyle = /\sstyle\s*=\s*(["']).*?\1/i.test(startTag)
    ? startTag.replace(/\sstyle\s*=\s*(["']).*?\1/i, ' data-item-style-marker="true"')
    : startTag.replace(/>$/, ' data-item-style-marker="true">')
  return `${withoutStyle}${segment.slice(startTag.length)}`
}

const createRepeatExtraction = (
  moduleId: string,
  moduleHtml: string,
): RepeatExtraction | null => {
  const group = findRepeatGroup(moduleHtml)
  if (!group) return null
  const first = group[0]
  if (!first) return null

  const componentName = `${toComponentName(moduleId)}Item`
  const dataName = `${toIdentifier(moduleId)}Items`
  const firstTexts = collectTextParts(first.segment)
  const firstRefs = collectRefValues(first.segment)
  let template = replaceFirstRootStyleWithMarker(first.segment)

  firstTexts.forEach((text, index) => {
    template = template.replace(text, `__TEXT_${index}__`)
  })
  firstRefs.forEach((ref, index) => {
    template = template.replace(
      new RegExp(`(${escapeRegExp(ref.attr)}\\s*=\\s*["'])${escapeRegExp(ref.value)}(["'])`, 'i'),
      `$1__REF_${index}__$2`,
    )
  })

  const items = group.map((item) => {
    const texts = collectTextParts(item.segment)
    const refs = collectRefValues(item.segment)
    const style = parseStyleObject(getAttr(item.startTag, 'style'))
    const record: Record<string, unknown> = { style }
    texts.forEach((text, index) => {
      record[`text${index}`] = text.trim()
    })
    refs.forEach((ref, index) => {
      record[`ref${index}`] = ref.value
    })
    return record
  })

  return {
    componentName,
    dataName,
    itemComponentHtml: template,
    items,
    paths: {},
  }
}

const getFrameworkTargetsFromFormats = (formats: OutputFormat[]) =>
  [...new Set(formats)].filter((format): format is FrameworkExportTarget =>
    FRAMEWORK_TARGETS.has(format as FrameworkExportTarget),
  )

const normalizeOutputFormats = (formats: unknown): OutputFormat[] => {
  const raw = Array.isArray(formats)
    ? formats
    : typeof formats === 'string'
      ? formats.split(',')
      : []
  const normalized = raw
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is OutputFormat =>
      item === 'html' || item === 'react' || item === 'vue',
    )
  return [...new Set<OutputFormat>(['html', ...normalized])]
}

const createAssetPolicyManifest = async ({
  assets,
  verifyDir,
}: {
  assets: FrameworkExportAsset[]
  verifyDir: string
}) => {
  await writeJsonFile(path.join(verifyDir, 'shell-manifest.json'), {
    entries: assets.map((asset) => ({
      assetPath: asset.copiedPath,
      category: 'framework-export-asset',
      containsIntrinsicText: false,
      containsText: false,
      htmlRef: asset.ref,
      name: path.basename(asset.copiedPath, path.extname(asset.copiedPath)),
      path: asset.copiedPath,
      sourcePath: asset.originalPath,
      textTreatment: 'copied-from-verified-html-output',
    })),
  })
}

const writeReactSharedLayer = async (componentsDir: string) => {
  const outputPath = path.join(componentsDir, 'SharedLayer.tsx')
  await writeTextFile(
    outputPath,
    `import React from 'react'

export type SharedLayerData = {
  className: string
  id: string
  kind: string
  src: string
  style: React.CSSProperties & Record<string, string | number>
}

export function SharedLayer({ layer }: { layer: SharedLayerData }) {
  return (
    <div
      className={layer.className}
      data-shared-layer-id={layer.id}
      data-shared-layer-kind={layer.kind}
      style={layer.style}
    >
      <img className="shared-design-layer__asset" src={layer.src} alt="" aria-hidden="true" />
    </div>
  )
}
`,
  )
  return outputPath
}

const writeReactRepeatComponent = async ({
  componentsDir,
  repeat,
}: {
  componentsDir: string
  repeat: RepeatExtraction
}) => {
  const outputPath = path.join(componentsDir, `${repeat.componentName}.tsx`)
  const jsx = htmlToJsx(repeat.itemComponentHtml)
  await writeTextFile(
    outputPath,
    `import React from 'react'

export type ${repeat.componentName}Data = {
  style: React.CSSProperties & Record<string, string | number>
} & Record<\`text\${number}\`, string> & Record<\`ref\${number}\`, string>

export function ${repeat.componentName}({ item }: { item: ${repeat.componentName}Data }) {
  return (
${indent(jsx, 4)}
  )
}
`,
  )
  repeat.paths.react = outputPath
  return outputPath
}

const writeReactModule = async ({
  componentsDir,
  module,
  repeat,
}: {
  componentsDir: string
  module: ModuleSection
  repeat: RepeatExtraction | null
}) => {
  const componentName = toComponentName(module.id)
  const outputPath = path.join(componentsDir, `${componentName}.tsx`)
  const imports = [
    `import React from 'react'`,
    repeat
      ? `import { ${repeat.componentName}, type ${repeat.componentName}Data } from './${repeat.componentName}'`
      : undefined,
  ].filter(Boolean)
  const body = repeat
    ? `const ${repeat.dataName}: ${repeat.componentName}Data[] = ${renderObjectLiteral(repeat.items)}

`
    : ''
  const inner = repeat
    ? `{${repeat.dataName}.map((item, index) => (
        <${repeat.componentName} key={index} item={item} />
      ))}`
    : htmlToJsx(module.innerHtml).trim()

  await writeTextFile(
    outputPath,
    `${imports.join('\n')}

${body}export function ${componentName}({ style }: { style?: React.CSSProperties }) {
  return (
    <section className="${module.className}" data-module-id="${module.id}" style={style}>
${indent(inner, 6)}
    </section>
  )
}
`,
  )
  return outputPath
}

const writeReactExport = async ({
  exportDir,
  model,
}: {
  exportDir: string
  model: PageModel
}) => {
  const componentsDir = path.join(exportDir, 'components')
  await mkdir(componentsDir, { recursive: true })
  const componentPaths = [await writeReactSharedLayer(componentsDir)]
  const repeats: RepeatExtraction[] = []

  for (const module of model.modules) {
    const repeat = createRepeatExtraction(module.id, module.innerHtml)
    if (repeat) {
      repeats.push(repeat)
      componentPaths.push(await writeReactRepeatComponent({ componentsDir, repeat }))
    }
    componentPaths.push(await writeReactModule({ componentsDir, module, repeat }))
  }

  const layerData = model.sharedLayers.map((layer) => ({
    className: layer.className,
    id: layer.id,
    kind: layer.kind,
    src: layer.src,
    style: parseStyleObject(layer.style),
  }))
  const moduleStyles = Object.fromEntries(
    model.modules.map((module) => [toIdentifier(module.id), parseStyleObject(module.style)]),
  )
  const imports = model.modules
    .map(
      (module) =>
        `import { ${toComponentName(module.id)} } from './components/${toComponentName(module.id)}'`,
    )
    .join('\n')
  const designPagePath = path.join(exportDir, 'DesignPage.tsx')
  await writeTextFile(
    designPagePath,
    `import React from 'react'
import './design.css'
import { SharedLayer, type SharedLayerData } from './components/SharedLayer'
${imports}

const sharedLayers: SharedLayerData[] = ${renderObjectLiteral(layerData)}

const moduleStyles = ${renderObjectLiteral(moduleStyles)}

export function DesignPage() {
  const underlays = sharedLayers.filter((layer) => layer.kind === 'shared-underlay')
  const overlays = sharedLayers.filter((layer) => layer.kind === 'shared-overlay')

  return (
    <main className="design-page">
      {underlays.map((layer) => (
        <SharedLayer key={layer.id} layer={layer} />
      ))}
${indent(
  model.modules
    .map(
      (module) =>
        `<${toComponentName(module.id)} style={moduleStyles.${toIdentifier(module.id)}} />`,
    )
    .join('\n'),
  6,
)}
      {overlays.map((layer) => (
        <SharedLayer key={layer.id} layer={layer} />
      ))}
    </main>
  )
}

export default DesignPage
`,
  )
  componentPaths.push(designPagePath)
  return { componentPaths, repeatComponentCount: repeats.length }
}

const writeVueSharedLayer = async (componentsDir: string) => {
  const outputPath = path.join(componentsDir, 'SharedLayer.vue')
  await writeTextFile(
    outputPath,
    `<template>
  <div
    :class="layer.className"
    :data-shared-layer-id="layer.id"
    :data-shared-layer-kind="layer.kind"
    :style="layer.style"
  >
    <img class="shared-design-layer__asset" :src="layer.src" alt="" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  layer: {
    className: string
    id: string
    kind: string
    src: string
    style: Record<string, string | number>
  }
}>()
</script>
`,
  )
  return outputPath
}

const writeVueRepeatComponent = async ({
  componentsDir,
  repeat,
}: {
  componentsDir: string
  repeat: RepeatExtraction
}) => {
  const outputPath = path.join(componentsDir, `${repeat.componentName}.vue`)
  await writeTextFile(
    outputPath,
    `<template>
${indent(htmlToVueTemplate(repeat.itemComponentHtml), 2)}
</template>

<script setup lang="ts">
defineProps<{
  item: Record<string, string | Record<string, string | number>>
}>()
</script>
`,
  )
  repeat.paths.vue = outputPath
  return outputPath
}

const writeVueModule = async ({
  componentsDir,
  module,
  repeat,
}: {
  componentsDir: string
  module: ModuleSection
  repeat: RepeatExtraction | null
}) => {
  const componentName = toComponentName(module.id)
  const outputPath = path.join(componentsDir, `${componentName}.vue`)
  const script = repeat
    ? `<script setup lang="ts">
import ${repeat.componentName} from './${repeat.componentName}.vue'

defineProps<{
  style?: Record<string, string | number>
}>()

const ${repeat.dataName} = ${renderObjectLiteral(repeat.items)}
</script>`
    : `<script setup lang="ts">
defineProps<{
  style?: Record<string, string | number>
}>()
</script>`
  const inner = repeat
    ? `<${repeat.componentName}
      v-for="(item, index) in ${repeat.dataName}"
      :key="index"
      :item="item"
    />`
    : htmlToVueTemplate(module.innerHtml).trim()
  await writeTextFile(
    outputPath,
    `<template>
  <section class="${module.className}" data-module-id="${module.id}" :style="style">
${indent(inner, 4)}
  </section>
</template>

${script}
`,
  )
  return outputPath
}

const writeVueExport = async ({
  exportDir,
  model,
}: {
  exportDir: string
  model: PageModel
}) => {
  const componentsDir = path.join(exportDir, 'components')
  await mkdir(componentsDir, { recursive: true })
  const componentPaths = [await writeVueSharedLayer(componentsDir)]
  const repeats: RepeatExtraction[] = []

  for (const module of model.modules) {
    const repeat = createRepeatExtraction(module.id, module.innerHtml)
    if (repeat) {
      repeats.push(repeat)
      componentPaths.push(await writeVueRepeatComponent({ componentsDir, repeat }))
    }
    componentPaths.push(await writeVueModule({ componentsDir, module, repeat }))
  }

  const layerData = model.sharedLayers.map((layer) => ({
    className: layer.className,
    id: layer.id,
    kind: layer.kind,
    src: layer.src,
    style: parseStyleObject(layer.style),
  }))
  const moduleStyles = Object.fromEntries(
    model.modules.map((module) => [toIdentifier(module.id), parseStyleObject(module.style)]),
  )
  const imports = model.modules
    .map(
      (module) =>
        `import ${toComponentName(module.id)} from './components/${toComponentName(module.id)}.vue'`,
    )
    .join('\n')
  const designPagePath = path.join(exportDir, 'DesignPage.vue')
  await writeTextFile(
    designPagePath,
    `<template>
  <main class="design-page">
    <SharedLayer
      v-for="layer in underlays"
      :key="layer.id"
      :layer="layer"
    />
${indent(
  model.modules
    .map(
      (module) =>
        `<${toComponentName(module.id)} :style="moduleStyles.${toIdentifier(module.id)}" />`,
    )
    .join('\n'),
  4,
)}
    <SharedLayer
      v-for="layer in overlays"
      :key="layer.id"
      :layer="layer"
    />
  </main>
</template>

<script setup lang="ts">
import './design.css'
import SharedLayer from './components/SharedLayer.vue'
${imports}

const sharedLayers = ${renderObjectLiteral(layerData)}

const moduleStyles = ${renderObjectLiteral(moduleStyles)}

const underlays = sharedLayers.filter((layer) => layer.kind === 'shared-underlay')
const overlays = sharedLayers.filter((layer) => layer.kind === 'shared-overlay')
</script>
`,
  )
  componentPaths.push(designPagePath)
  return { componentPaths, repeatComponentCount: repeats.length }
}

const exportSingleTarget = async ({
  design,
  model,
  rootArtifactDir,
  runVerify,
  target,
  regionsPath,
  onProgress,
}: {
  design: DesignPair
  model: PageModel
  rootArtifactDir: string
  runVerify: boolean
  target: FrameworkExportTarget
  regionsPath?: string
  onProgress?: (message: string) => void
}): Promise<FrameworkExportRecord> => {
  const exportDir = path.join(rootArtifactDir, 'exports', target)
  const htmlDir = path.dirname(design.htmlPath)
  await mkdir(exportDir, { recursive: true })
  const refs = collectLocalRefs(`${model.html}\n${model.css}`)
  const { assets, replacements } = await copyReferencedAssets({
    exportDir,
    htmlDir,
    refs,
  })
  const rewrittenHtml = replaceRefs(model.html, replacements)
  const rewrittenCss = replaceRefs(model.css, replacements)
  const rewrittenModel = await buildPageModelFromHtml(rewrittenHtml)
  const cssPath = path.join(exportDir, 'design.css')
  const previewHtmlPath = path.join(exportDir, 'preview.html')
  const assetManifestPath = path.join(exportDir, 'asset-manifest.json')

  await writeTextFile(cssPath, rewrittenCss)
  await writeTextFile(previewHtmlPath, rewrittenHtml)
  await writeJsonFile(assetManifestPath, {
    assets,
    sourceHtmlPath: design.htmlPath,
    target,
  })

  const sourceResult =
    target === 'react'
      ? await writeReactExport({ exportDir, model: rewrittenModel })
      : await writeVueExport({ exportDir, model: rewrittenModel })

  let verifyResult: VerifyResult | undefined
  if (runVerify) {
    const verifyDir = path.join(exportDir, 'verify')
    await mkdir(verifyDir, { recursive: true })
    await createAssetPolicyManifest({ assets, verifyDir })
    onProgress?.(`[framework-export:${target}] verifying preview.html`)
    verifyResult = await verifyDesign(
      design.svgPath,
      (message) => onProgress?.(`[framework-export:${target}:verify] ${message}`),
      verifyDir,
      regionsPath,
      {
        htmlPath: previewHtmlPath,
        mode: 'full',
        reuseCachedOcr: true,
        scale: design.scale,
      },
    )
  }

  return {
    assetManifestPath,
    assets,
    componentPaths: sourceResult.componentPaths,
    cssPath,
    dir: exportDir,
    previewHtmlPath,
    repeatComponentCount: sourceResult.repeatComponentCount,
    status: 'completed',
    target,
    verifyResult,
  }
}

const buildPageModelFromHtml = async (html: string): Promise<PageModel> => {
  const tmpPath = `inline://${createHash('sha1').update(html).digest('hex')}`
  void tmpPath
  const designPage = findDesignPage(html)
  const pageElements = findTopLevelElements(designPage.innerHtml)
  const modules: ModuleSection[] = []
  const sharedLayers: SharedLayer[] = []
  pageElements.forEach((element) => {
    if (hasClass(element.startTag, 'design-module')) {
      const id = getAttr(element.startTag, 'data-module-id')
      if (id) {
        modules.push({
          className: getAttr(element.startTag, 'class'),
          id,
          innerHtml: element.innerHtml,
          startTag: element.startTag,
          style: getAttr(element.startTag, 'style'),
        })
      }
    } else if (hasClass(element.startTag, 'shared-design-layer')) {
      sharedLayers.push({
        className: getAttr(element.startTag, 'class'),
        id: getAttr(element.startTag, 'data-shared-layer-id'),
        innerHtml: element.innerHtml,
        kind: getAttr(element.startTag, 'data-shared-layer-kind'),
        src: extractImageSource(element.innerHtml),
        style: getAttr(element.startTag, 'style'),
      })
    }
  })
  return {
    css: extractStyleCss(html),
    designPageInner: designPage.innerHtml,
    designPageOpenTag: designPage.startTag,
    html,
    modules,
    sharedLayers,
  }
}

const exportFrameworkTargets = async ({
  artifactDir,
  design,
  formats,
  onProgress,
  regionsPath,
  runVerify = true,
}: ExportFrameworkTargetsInput) => {
  const targets = getFrameworkTargetsFromFormats(formats)
  const records: Partial<Record<FrameworkExportTarget, FrameworkExportRecord>> = {}
  if (!targets.length) return records

  const model = await buildPageModel(design.htmlPath)
  for (const target of targets) {
    onProgress?.(`[framework-export:${target}] exporting components`)
    try {
      records[target] = await exportSingleTarget({
        design,
        model,
        onProgress,
        regionsPath,
        rootArtifactDir: artifactDir,
        runVerify,
        target,
      })
    } catch (error) {
      records[target] = {
        dir: path.join(artifactDir, 'exports', target),
        error: error instanceof Error ? error.message : String(error),
        status: 'failed',
        target,
      }
    }
  }

  return records
}

export type {
  FrameworkExportRecord,
  FrameworkExportTarget,
  OutputFormat,
}
export {
  exportFrameworkTargets,
  getFrameworkTargetsFromFormats,
  normalizeOutputFormats,
}
