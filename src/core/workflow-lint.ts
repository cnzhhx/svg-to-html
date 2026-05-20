import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { capturePage, evaluatePage, launchEdge } from './cdp.js'
import { readJsonIfExists } from './io.js'
import { type OcrResult, detectOcrSupport, runOcr } from './ocr.js'
import startStaticServer from './static-server.js'
import {
  resolveDesignPair,
  resolveSvgDesign,
  toAbsolutePath,
  toUrlPath,
  writeJsonFile,
  writeTextFile,
} from './utils.js'
import { attachRecommendedRecipes } from './workflow-lint/recipes.js'
import { renderWorkflowLintMarkdown } from './workflow-lint/report.js'

import type {
  ContainerLayoutRecipe,
  WorkflowLintIssue,
  WorkflowLintReport,
} from './workflow-lint/types.js'

type SvgDimensions = {
  height: number
  width: number
}

type LocalSvgAssetReference = {
  assetPath: string
  ref: string
  selector: string
}

type AssetMetadataEntry = {
  assetName?: string
  assetPath?: string
  category?: string
  containsIntrinsicText?: boolean
  containsText?: boolean
  description?: string
  name?: string
  path?: string
  pngPath?: string
  reason?: string
  relativePath?: string
  svgPath?: string
  textTreatment?: string
  [key: string]: unknown
}

type AssetMetadataRecord = {
  baseDir: string
  entry: AssetMetadataEntry
}

const GENERATED_ASSET_COLLECTION_KEYS = [
  'generatedAssets',
  'producedAssets',
  'localAssets',
  'moduleAssets',
] as const

const HTML_ASSET_REF_RE =
  /(?:src|href)\s*=\s*["']([^"']+\.svg(?:[?#][^"']*)?)["']|url\(\s*["']?([^"')]+\.svg(?:[?#][^"')]+)?)["']?\s*\)/gi

const stripQueryAndHash = (value: string) => value.split(/[?#]/, 1)[0] ?? value

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const isRemoteOrDataUrl = (value: string) =>
  /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value) || /^data:/i.test(value)

const normalizeAssetText = (value: string) => value.replace(/\s+/g, '').trim()

const normalizePathKey = (value: string) =>
  path.resolve(value).replaceAll('\\', '/').toLowerCase()

const collectAssetMetadataRecords = (
  value: unknown,
  baseDir: string,
): AssetMetadataRecord[] => {
  const toRecord = (entry: unknown): AssetMetadataRecord[] =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? [{ baseDir, entry: entry as AssetMetadataEntry }]
      : []

  if (Array.isArray(value)) return value.flatMap(toRecord)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }

  return GENERATED_ASSET_COLLECTION_KEYS.flatMap((key) => {
    const collection = (value as Record<string, unknown>)[key]
    return Array.isArray(collection) ? collection.flatMap(toRecord) : []
  })
}

const readModuleGeneratedAssetMetadataRecords = async ({
  artifactDir,
}: {
  artifactDir: string
}) => {
  const modulesDir = path.join(artifactDir, 'modules')
  const entries = await readdir(modulesDir, { withFileTypes: true }).catch(
    () => null,
  )
  if (!entries) return []

  const records = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && /^module-[\w-]+$/.test(entry.name),
      )
      .map(async (entry) => {
        const moduleDir = path.join(modulesDir, entry.name)
        const manifest = await readJsonIfExists<unknown>(
          path.join(moduleDir, 'manifest.json'),
        )
        return collectAssetMetadataRecords(manifest, moduleDir)
      }),
  )
  return records.flat()
}

const readAssetMetadataEntries = async ({
  artifactDir,
}: {
  artifactDir: string
}) => {
  const shellManifest = await readJsonIfExists<unknown>(
    path.join(artifactDir, 'shell-manifest.json'),
  )
  return [
    ...collectAssetMetadataRecords(shellManifest, artifactDir),
    ...(await readModuleGeneratedAssetMetadataRecords({ artifactDir })),
  ]
}

const createAssetMetadataLookup = async ({
  artifactDir,
  design,
}: {
  artifactDir: string
  design: Awaited<ReturnType<typeof resolveDesignPair>>
}) => {
  const htmlDir = path.dirname(design.htmlPath)
  const byBasename = new Map<string, AssetMetadataEntry>()
  const byPath = new Map<string, AssetMetadataEntry>()

  for (const { baseDir, entry } of await readAssetMetadataEntries({
    artifactDir,
  })) {
    for (const name of [entry.name, entry.assetName]) {
      if (typeof name === 'string' && name) byBasename.set(name, entry)
    }

    for (const raw of [
      entry.assetPath,
      entry.svgPath,
      entry.pngPath,
      entry.path,
      entry.relativePath,
    ]) {
      if (typeof raw !== 'string' || !raw) continue
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw)
      byPath.set(normalizePathKey(resolved), entry)
      byPath.set(normalizePathKey(path.resolve(htmlDir, raw)), entry)
      byBasename.set(
        path.basename(resolved).replace(/\.(?:svg|png|webp|jpe?g|avif)$/i, ''),
        entry,
      )
    }
  }

  return { byBasename, byPath }
}

const getAssetDescriptor = (entry: AssetMetadataEntry | undefined) =>
  [
    entry?.assetName,
    entry?.name,
    entry?.category,
    entry?.description,
    entry?.reason,
    entry?.textTreatment,
    entry?.assetRole,
    entry?.assetType,
    entry?.kind,
    entry?.type,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()

const descriptorDeclaresStylizedText = (descriptor: string) =>
  /\b(?:stylized|artistic|intertwined|fused|logo|brand|decorative|lettering|cover|thumbnail|artwork)\b|(?:艺术字|品牌|标志|装饰字|封面字形|交织)/i.test(
    descriptor,
  )

const metadataAllowsAtomicTextSvg = (entry: AssetMetadataEntry | undefined) => {
  const treatment =
    typeof entry?.textTreatment === 'string'
      ? entry.textTreatment.toLowerCase()
      : ''
  if (!/atomic-svg-node-visual-text-asset/.test(treatment)) return false

  const descriptor = getAssetDescriptor(entry)
  if (
    /\b(?:layout|page|full-page|shell|fallback)\b|(?:整页|大壳层|页面)/i.test(
      descriptor,
    )
  ) {
    return false
  }
  return true
}

const readSvgDimensions = (svg: string): SvgDimensions => {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const viewBox = root.match(/\bviewBox=["']([^"']+)["']/i)?.[1]
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map((item) => Number(item))
    const width = parts[2]
    const height = parts[3]
    if (
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { height: Math.ceil(height), width: Math.ceil(width) }
    }
  }

  const width = Number(root.match(/\bwidth=["']([\d.]+)/i)?.[1])
  const height = Number(root.match(/\bheight=["']([\d.]+)/i)?.[1])
  return {
    height: Number.isFinite(height) && height > 0 ? Math.ceil(height) : 1,
    width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : 1,
  }
}

const collectLocalSvgAssetReferences = async ({
  design,
}: {
  design: Awaited<ReturnType<typeof resolveDesignPair>>
}): Promise<LocalSvgAssetReference[]> => {
  const html = await readFile(design.htmlPath, 'utf8')
  const htmlDir = path.dirname(design.htmlPath)
  const references = new Map<string, { ref: string; selector: string }>()

  for (const match of html.matchAll(HTML_ASSET_REF_RE)) {
    const rawRef = match[1] ?? match[2] ?? ''
    if (!rawRef || isRemoteOrDataUrl(rawRef)) continue

    const cleanRef = safeDecodeURIComponent(stripQueryAndHash(rawRef))
    const assetPath = path.resolve(htmlDir, cleanRef)
    const relativeToHtmlDir = path.relative(htmlDir, assetPath)

    if (path.resolve(assetPath) === path.resolve(design.svgPath)) continue
    if (
      relativeToHtmlDir.startsWith('..') ||
      path.isAbsolute(relativeToHtmlDir)
    )
      continue
    if (!/\.svg$/i.test(assetPath)) continue

    references.set(assetPath, {
      ref: rawRef,
      selector: `[src="${rawRef}"], [href="${rawRef}"]`,
    })
  }

  return [...references.entries()].map(([assetPath, value]) => ({
    assetPath,
    ...value,
  }))
}

const createSvgAssetTextIssues = async ({
  artifactDir,
  browserPort,
  design,
  serverOrigin,
}: {
  artifactDir: string
  browserPort: number
  design: Awaited<ReturnType<typeof resolveDesignPair>>
  serverOrigin: string
}): Promise<WorkflowLintIssue[]> => {
  const refs = await collectLocalSvgAssetReferences({ design })
  const metadataLookup = await createAssetMetadataLookup({
    artifactDir,
    design,
  })
  const issues: WorkflowLintIssue[] = []
  const ocrSupport = detectOcrSupport()

  for (const ref of refs) {
    const basename = path
      .basename(ref.assetPath)
      .replace(/\.(?:svg|png|webp|jpe?g|avif)$/i, '')
    const metadata =
      metadataLookup.byPath.get(normalizePathKey(ref.assetPath)) ??
      metadataLookup.byBasename.get(basename)
    const descriptor = getAssetDescriptor(metadata)
    const isStylizedTextAsset = descriptorDeclaresStylizedText(descriptor)
    const isAtomicTextSvgAsset = metadataAllowsAtomicTextSvg(metadata)
    let svg = ''
    try {
      svg = await readFile(ref.assetPath, 'utf8')
    } catch {
      continue
    }

    const inlineText = normalizeAssetText(
      [...svg.matchAll(/<(?:text|tspan)\b[^>]*>([\s\S]*?)<\/(?:text|tspan)>/gi)]
        .map((match) => match[1] ?? '')
        .join(' '),
    )

    if (inlineText) {
      if (isStylizedTextAsset || isAtomicTextSvgAsset) continue
      issues.push({
        kind: 'text-bearing-svg-asset',
        selectors: [ref.selector],
        severity: 'error',
        summary: `本地 SVG 背景资源 ${ref.ref} 包含 <text>/<tspan> 文本。抽出的 SVG 背景必须是纯背景/装饰，所有可读文字必须用真实 DOM 文本实现。`,
      })
      continue
    }

    if (!ocrSupport.available) continue

    const dims = readSvgDimensions(svg)
    if (dims.width <= 1 || dims.height <= 1) continue

    const baseName = path
      .basename(ref.assetPath, '.svg')
      .replace(/[^\w.-]+/g, '_')
    const wrapperPath = path.join(
      artifactDir,
      `workflow-lint-svg-asset-${baseName}.html`,
    )
    const pngPath = path.join(
      artifactDir,
      `workflow-lint-svg-asset-${baseName}.png`,
    )
    const ocrPath = path.join(
      artifactDir,
      `workflow-lint-svg-asset-${baseName}-ocr.json`,
    )

    await writeTextFile(
      wrapperPath,
      `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<style>html,body{margin:0;width:${dims.width}px;height:${dims.height}px;overflow:hidden;background:transparent}img{display:block;width:${dims.width}px;height:${dims.height}px}</style>
</head><body><img src="${toUrlPath(ref.assetPath)}" alt="" />
<script>window.addEventListener('load',()=>{setTimeout(()=>{window.__RENDER_READY__=true},200)})</script>
</body></html>`,
    )

    try {
      await capturePage({
        outputPath: pngPath,
        port: browserPort,
        transparentBackground: true,
        url: `${serverOrigin}${toUrlPath(wrapperPath)}`,
        viewportHeight: dims.height,
        viewportWidth: dims.width,
      })
      await runOcr({ imagePath: pngPath, outputPath: ocrPath })
      const ocr = JSON.parse(await readFile(ocrPath, 'utf8')) as OcrResult
      const text = normalizeAssetText(ocr.fullText)
      if (!text) continue
      if (isStylizedTextAsset || isAtomicTextSvgAsset) continue

      issues.push({
        kind: 'text-bearing-svg-asset',
        selectors: [ref.selector],
        severity: 'error',
        summary: `本地 SVG 背景资源 ${ref.ref} OCR 识别出可读文字 "${text.slice(0, 40)}"。抽出的 SVG 背景必须是纯背景/装饰，不能复制整张含文字 SVG 来做背景。`,
      })
    } catch {
      // Keep workflow lint stable if an auxiliary render/OCR pass fails.
    }
  }

  return issues
}

const createCssHandDrawnIconIssues = (html: string): WorkflowLintIssue[] => {
  const issues: WorkflowLintIssue[] = []
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  const rulePattern = /([^{}@][^{}]*)\{([^{}]*)\}/g
  const seen = new Set<string>()

  for (const styleMatch of html.matchAll(stylePattern)) {
    const css = styleMatch[1] ?? ''
    for (const ruleMatch of css.matchAll(rulePattern)) {
      const selector = (ruleMatch[1] ?? '').trim()
      const body = (ruleMatch[2] ?? '').trim()
      if (!/::?(?:before|after)\b/i.test(selector)) continue

      const drawsWithRadiusAndRotate =
        /\bborder-radius\s*:/i.test(body) &&
        /\btransform\s*:[^;]*rotate\(/i.test(body)
      const usesIconGlyphContent =
        /\bcontent\s*:\s*["']\s*(?:☰|≡|⋯|…|›|‹|→|←|⌕|🔍|📅|✓|✔)\s*["']/u.test(
          body,
        )
      if (!drawsWithRadiusAndRotate && !usesIconGlyphContent) continue

      const key = `${selector}:${drawsWithRadiusAndRotate}:${usesIconGlyphContent}`
      if (seen.has(key)) continue
      seen.add(key)

      issues.push({
        kind: 'css-hand-drawn-icon',
        selectors: [selector],
        severity: 'warning',
        summary: drawsWithRadiusAndRotate
          ? '检测到伪元素通过 border-radius + rotate 手绘图标。跨浏览器像素还原不稳定，优先改成本地 SVG/icon 资源或真实 DOM 图标。'
          : '检测到伪元素使用字符 content 充当图标。普通文字和图标语义容易混淆，优先使用本地 SVG/icon 资源。',
      })
    }
  }

  return issues
}

const dedupeIssues = (issues: WorkflowLintIssue[]) => {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.kind}:${issue.selectors.join('|')}:${issue.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const createWorkflowLintReport = async ({
  artifactDir,
  htmlPath,
  inputPath,
  scale,
}: {
  artifactDir: string
  htmlPath?: string
  inputPath: string
  scale?: number
}) => {
  const resolvedDesign = htmlPath
    ? await resolveSvgDesign(inputPath, { scale })
    : await resolveDesignPair(inputPath, { scale })
  const design = htmlPath
    ? {
        ...resolvedDesign,
        htmlPath: toAbsolutePath(htmlPath),
      }
    : resolvedDesign
  const outputPath = path.join(artifactDir, 'workflow-lint.json')
  const markdownPath = path.join(artifactDir, 'workflow-lint.md')
  const server = await startStaticServer()
  const browser = await launchEdge()

  try {
    const domIssues = await evaluatePage<WorkflowLintIssue[]>({
      expression: `(() => {
        const root = document.querySelector('.design-page, .sale-page') ?? document.body
        const rootRect = root.getBoundingClientRect()
        const minEditableTextOpacity = 0.1

        const normalizeText = (value) => value.replace(/\\s+/g, ' ').trim()
        const parsePx = (value) => {
          const next = Number.parseFloat(value)
          return Number.isFinite(next) ? next : 0
        }
        const buildNodePath = (node) => {
          const segments = []
          let current = node

          while (current && current instanceof HTMLElement) {
            const parent = current.parentElement
            const tag = current.tagName.toLowerCase()
            const siblings = parent
              ? [...parent.children].filter((item) => item.tagName === current.tagName)
              : [current]
            const index = siblings.indexOf(current) + 1
            segments.unshift(tag + ':nth-of-type(' + index + ')')
            if (current === document.body) break
            current = parent
          }

          return segments.join(' > ')
        }
        const toBox = (rect) => ({
          x: Number((rect.left - rootRect.left).toFixed(3)),
          y: Number((rect.top - rootRect.top).toFixed(3)),
          width: Number(rect.width.toFixed(3)),
          height: Number(rect.height.toFixed(3)),
        })
        const unionBoxes = (boxes) => {
          const minX = Math.min(...boxes.map((box) => box.x))
          const minY = Math.min(...boxes.map((box) => box.y))
          const maxX = Math.max(...boxes.map((box) => box.x + box.width))
          const maxY = Math.max(...boxes.map((box) => box.y + box.height))
          return {
            x: Number(minX.toFixed(3)),
            y: Number(minY.toFixed(3)),
            width: Number((maxX - minX).toFixed(3)),
            height: Number((maxY - minY).toFixed(3)),
          }
        }
        const isTransparent = (value) => {
          const normalized = String(value || '').trim().toLowerCase()
          if (normalized === 'transparent') return true
          const rgba = normalized.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/)
          if (rgba) {
            const alpha = Number(rgba[1])
            return Number.isFinite(alpha) && alpha <= 0.05
          }
          const hexAlpha = normalized.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i)
          if (hexAlpha) {
            const alpha = Number.parseInt(hexAlpha[1], 16) / 255
            return Number.isFinite(alpha) && alpha <= 0.05
          }
          return false
        }
        const intersectionArea = (left, right) => {
          const overlapX = Math.max(
            0,
            Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
          )
          const overlapY = Math.max(
            0,
            Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
          )
          return overlapX * overlapY
        }
        const overlapRatio = (left, right) => {
          const overlap = intersectionArea(left, right)
          if (!overlap) return 0
          const leftArea = Math.max(1, left.width * left.height)
          const rightArea = Math.max(1, right.width * right.height)
          return overlap / Math.min(leftArea, rightArea)
        }
        const readTextLayoutBlocks = () => {
          try {
            const script = document.querySelector('script[data-text-layout-config]')
            if (!script) return []
            const parsed = JSON.parse(script.textContent || '{}')
            return Array.isArray(parsed.blocks) ? parsed.blocks : []
          } catch {
            return []
          }
        }
        const hasInvisibleSelfOrAncestor = (element) => {
          let current = element
          while (current && current instanceof HTMLElement) {
            const style = getComputedStyle(current)
            const opacity = Number(style.opacity)
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              (Number.isFinite(opacity) && opacity <= minEditableTextOpacity)
            ) {
              return true
            }
            if (current === root || current === document.body) break
            current = current.parentElement
          }
          return false
        }
        const readBackgroundImageSources = (element) => {
          const backgroundImage = getComputedStyle(element).backgroundImage
          if (!backgroundImage || backgroundImage === 'none') return []
          return [...backgroundImage.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)]
            .map((match) => match[1] ?? '')
            .filter(Boolean)
        }
        const isShortToken = (value) => {
          const text = normalizeText(value)
          if (!text) return false
          if (text.length <= 4 && /^[\\d:：;；.,，%+\\-]+$/.test(text)) return true
          if (text.length <= 3 && /^(?:天|时|分|秒|折|元)$/.test(text)) return true
          return text.length <= 4 && /^[A-Za-z\\d]+$/.test(text)
        }
        const isVisibleElement = (element) => {
          if (!(element instanceof HTMLElement)) return false
          const style = getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const leafTextElements = [...document.body.querySelectorAll('*')]
          .filter((element) => {
            if (!(element instanceof HTMLElement)) return false
            if (element.children.length > 0) return false
            const text = normalizeText(element.textContent ?? '')
            if (!text) return false
            return isVisibleElement(element)
          })

        const nestedCandidates = leafTextElements
          .map((element) => {
            const text = normalizeText(element.textContent ?? '')
            if (!isShortToken(text)) return null

            const style = getComputedStyle(element)
            if (style.position !== 'absolute') return null

            const parent = element.parentElement
            if (!(parent instanceof HTMLElement)) return null
            const parentStyle = getComputedStyle(parent)
            const parentBox = toBox(parent.getBoundingClientRect())
            const textChildren = [...parent.children].filter((child) => {
              if (!(child instanceof HTMLElement)) return false
              return normalizeText(child.textContent ?? '').length > 0
            })
            const hasShellAppearance =
              !isTransparent(parentStyle.backgroundColor) ||
              parentStyle.backgroundImage !== 'none' ||
              parsePx(parentStyle.borderRadius) > 0 ||
              parsePx(parentStyle.borderWidth) > 0

            if (textChildren.length !== 1) return null
            if (parentBox.width > 72 || parentBox.height > 72) return null
            if (parentBox.width < 14 || parentBox.height < 14) return null
            if (!hasShellAppearance) return null
            if (
              style.left === 'auto' &&
              style.top === 'auto' &&
              parentStyle.display !== 'flex' &&
              parentStyle.display !== 'inline-flex'
            ) {
              return null
            }

            return {
              childSelector: buildNodePath(element),
              parentBox,
              parentSelector: buildNodePath(parent),
              rowSelector: buildNodePath(parent.parentElement ?? parent),
              text,
              yBucket: Math.round(parentBox.y / 8),
            }
          })
          .filter(Boolean)

        const issues = nestedCandidates.map((candidate) => ({
          kind: 'nested-cell-text',
          region: candidate.parentBox,
          selectors: [candidate.childSelector, candidate.parentSelector],
          severity: 'warning',
          summary:
            '发现“小壳层 + 单短文本”的嵌套 cell。最终 HTML 不应继续保留内层 label 手工偏移，应该压平成单节点 cell，或把整段短文本组合改成壳层 + 直接文本碎片。',
        }))

        const rowGroups = new Map()
        nestedCandidates.forEach((candidate) => {
          const key = candidate.rowSelector + '::' + candidate.yBucket
          const current = rowGroups.get(key) ?? []
          current.push(candidate)
          rowGroups.set(key, current)
        })

        rowGroups.forEach((group) => {
          if (group.length < 3) return
          issues.push({
            kind: 'short-token-row-nested-cells',
            region: unionBoxes(group.map((item) => item.parentBox)),
            selectors: group.map((item) => item.childSelector),
            severity: 'error',
            summary:
              '检测到一整排短 token 被实现成多个“小壳层 cell + 内层绝对定位文本”。这类短文本组合应优先还原为完整壳层 + 直接文本碎片，或压平后的单节点 cell，不能靠内层 offset 对字。',
          })
        })

        leafTextElements.forEach((element) => {
          const text = normalizeText(element.textContent ?? '')
          if (!['：', '；'].includes(text)) return

          const parent = element.parentElement
          const scanRoot = parent?.parentElement ?? parent ?? element
          const siblings = [...scanRoot.querySelectorAll('*')]
            .filter((node) => node instanceof HTMLElement)
            .map((node) => normalizeText(node.textContent ?? ''))
            .filter(Boolean)
          const hasDigitContext = siblings.some((value) => /\\d/.test(value))
          if (!hasDigitContext) return

          issues.push({
            kind: 'fullwidth-punctuation',
            region: toBox(element.getBoundingClientRect()),
            selectors: [buildNodePath(element)],
            severity: 'error',
            summary:
              '数字 token 行里出现了全角标点。紧凑数值文本默认应使用半角冒号/分号，否则会直接破坏字形宽度和位置反算。',
          })
        })

        const trackedTextBlocks = readTextLayoutBlocks()
          .map((block) => {
            const selectors = Array.isArray(block.selectors) ? block.selectors : []
            const region = block.region
            const selector = selectors.find((value) => typeof value === 'string') ?? ''
            if (!selector || !region) return null
            const element = document.querySelector(selector)
            if (!(element instanceof HTMLElement)) return null
            const text = normalizeText(element.textContent ?? '')
            if (!text) return null
            return {
              box: {
                x: Number(region.x),
                y: Number(region.y),
                width: Number(region.width),
                height: Number(region.height),
              },
              element,
              selector,
              text,
            }
          })
          .filter(Boolean)

        const hiddenTrackedTextBlocks = []

        trackedTextBlocks.forEach((block) => {
          const style = getComputedStyle(block.element)
          const rect = block.element.getBoundingClientRect()
          const opacity = Number(style.opacity)
          const invisible =
            hasInvisibleSelfOrAncestor(block.element) ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            (Number.isFinite(opacity) && opacity <= minEditableTextOpacity) ||
            isTransparent(style.color) ||
            rect.width <= 0 ||
            rect.height <= 0
          if (!invisible) return

          hiddenTrackedTextBlocks.push(block)

          issues.push({
            kind: 'hidden-editable-text',
            region: block.box,
            selectors: [block.selector],
            severity: 'error',
            summary:
              '检测到带文本内容的 tracked 元素被隐藏。最终 HTML 中变量文本必须可见并可编辑，不能把真实文本隐藏后用截图/裁片替代。',
          })
        })

        const visualAssetRefs = [root, ...root.querySelectorAll('*')]
          .filter((node) => node instanceof HTMLElement)
          .flatMap((element) => {
            const sources = []
            if (element instanceof HTMLImageElement) {
              sources.push(element.getAttribute('src') ?? '')
            }
            sources.push(...readBackgroundImageSources(element))
            return sources
              .filter((src) => src && !/^(?:[a-z][a-z\\d+.-]*:)?\\/\\//i.test(src) && !/^data:/i.test(src))
              .map((src) => ({
                box: toBox(element.getBoundingClientRect()),
                selector: buildNodePath(element),
                src,
              }))
          })
          .filter((item) => item.box.width > 0 && item.box.height > 0)

        visualAssetRefs.forEach((asset) => {
          const overlappedText = hiddenTrackedTextBlocks.find(
            (block) => overlapRatio(asset.box, block.box) >= 0.18,
          )
          if (!overlappedText) return

          issues.push({
            kind: 'text-bitmap-crop',
            region: asset.box,
            selectors: [asset.selector, overlappedText.selector],
            severity: 'error',
            summary:
              '检测到隐藏 tracked 文本区域被视觉资源覆盖（' +
              asset.src +
              '）。文字裁片只能作为临时对齐参考，最终产物必须使用真实 DOM 文本渲染，确保变量可修改。',
          })
        })

        const rootChildren = [...root.children].filter((element) =>
          isVisibleElement(element),
        )
        const flatRootChildren = rootChildren.filter((element) => {
          if (!(element instanceof HTMLElement)) return false
          const style = getComputedStyle(element)
          const tag = element.tagName.toLowerCase()
          const descendants = [...element.querySelectorAll('*')].filter((node) =>
            isVisibleElement(node),
          )
          if (
            ['section', 'article', 'header', 'footer', 'main', 'nav', 'ul', 'ol', 'li'].includes(tag)
          ) {
            return false
          }
          if (['grid', 'inline-grid', 'flex', 'inline-flex'].includes(style.display)) {
            return false
          }
          if (descendants.length >= 4) return false
          if (element.children.length >= 3) return false
          return style.position === 'absolute' || descendants.length === 0
        })

        if (
          rootChildren.length >= 8 &&
          flatRootChildren.length >= Math.max(6, Math.ceil(rootChildren.length * 0.65))
        ) {
          issues.push({
            kind: 'flat-root-structure',
            region: toBox(root.getBoundingClientRect()),
            selectors: [
              buildNodePath(root),
              ...flatRootChildren.slice(0, 4).map((element) => buildNodePath(element)),
            ],
            severity: 'error',
            summary:
              '页面根节点下堆了过多直接叶子节点，结构仍然接近平铺散点。应先建立顶层 section/article/card，再把文本、位图和装饰分配进对应容器。',
          })
        }

        const shellAssetPattern = /(?:^|\\/)shell-[^/]+\\.svg(?:[?#].*)?$/i
        const rootLevelShellFallbacks = rootChildren
          .filter((element) => element instanceof HTMLElement)
          .map((element) => {
            const shellImages = [...element.querySelectorAll('img')]
              .filter((node) => node instanceof HTMLImageElement)
              .filter((node) => shellAssetPattern.test(node.getAttribute('src') ?? ''))
            if (!shellImages.length) return null

            const elementRect = element.getBoundingClientRect()
            const box = toBox(elementRect)
            const rootArea = Math.max(1, rootRect.width * rootRect.height)
            const overlapArea = Math.max(
              0,
              Math.min(elementRect.right, rootRect.right) - Math.max(elementRect.left, rootRect.left),
            ) * Math.max(
              0,
              Math.min(elementRect.bottom, rootRect.bottom) - Math.max(elementRect.top, rootRect.top),
            )
            const rootCoverage = overlapArea / rootArea
            const widthCoverage = Math.min(elementRect.width, rootRect.width) / Math.max(1, rootRect.width)
            const heightCoverage = Math.min(elementRect.height, rootRect.height) / Math.max(1, rootRect.height)
            const directShellChildCount = [...element.children].filter((child) => {
              if (!(child instanceof HTMLElement)) return false
              return child.querySelector('img[src]') instanceof HTMLImageElement
            }).length
            const elementLabel = [
              element.id,
              typeof element.className === 'string' ? element.className : '',
              element.getAttribute('data-role') ?? '',
              element.getAttribute('data-layer') ?? '',
            ].join(' ')
            const isDeclaredBackgroundUnderlay =
              element.getAttribute('aria-hidden') === 'true' &&
              /(?:bg|background|underlay|backdrop|page-bg|page-background|outer-bg)/i.test(elementLabel)

            if (rootCoverage < 0.72) return null
            if (widthCoverage < 0.85 || heightCoverage < 0.85) return null
            if (directShellChildCount > 1) return null
            if (isDeclaredBackgroundUnderlay) return null

            return {
              box,
              selector: buildNodePath(element),
              sources: shellImages.map((image) => image.getAttribute('src') ?? '').slice(0, 2),
            }
          })
          .filter(Boolean)

        rootLevelShellFallbacks.forEach((candidate) => {
          issues.push({
            kind: 'full-page-shell-fallback',
            region: candidate.box,
            selectors: [candidate.selector],
            severity: 'error',
            summary:
              '检测到根节点下存在覆盖整页或大部分画板的 shell SVG 兜底层。最终 HTML 不允许把带文本或未声明用途的整体 shell 直接挂成 page-level fallback；明确无文本的大背景必须作为 aria-hidden background/underlay，且真实 section/card/container 与文本仍需保留。',
          })
        })

        return issues
      })()`,
      port: browser.port,
      readyExpression:
        '(async () => { if (document.readyState !== "complete") return false; if (document.fonts) await document.fonts.ready; return true })()',
      url: `${server.origin}${toUrlPath(design.htmlPath)}`,
      viewportHeight: design.height,
      viewportWidth: design.width,
    })

    const containerLayout =
      (await readJsonIfExists<{ recipes?: ContainerLayoutRecipe[] }>(
        path.join(artifactDir, 'container-layout.json'),
      )) ?? {}
    const svgAssetTextIssues = await createSvgAssetTextIssues({
      artifactDir,
      browserPort: browser.port,
      design,
      serverOrigin: server.origin,
    })
    const html = await readFile(design.htmlPath, 'utf8')
    const cssHandDrawnIconIssues = createCssHandDrawnIconIssues(html)

    const issues = attachRecommendedRecipes({
      issues: dedupeIssues([
        ...domIssues,
        ...svgAssetTextIssues,
        ...cssHandDrawnIconIssues,
      ]),
      recipes: containerLayout.recipes ?? [],
    })
    const criticalIssues = issues.filter((issue) => issue.severity === 'error')
    const warningIssues = issues.filter((issue) => issue.severity === 'warning')

    const report: WorkflowLintReport = {
      criticalIssueCount: criticalIssues.length,
      designName: design.designName,
      issueCount: issues.length,
      issues,
      passed: criticalIssues.length === 0,
    }

    await writeJsonFile(outputPath, report)

    await writeTextFile(
      markdownPath,
      renderWorkflowLintMarkdown({
        criticalIssues,
        designName: design.designName,
        issues,
        warningIssues,
      }),
    )

    return { markdownPath, outputPath, report }
  } finally {
    await Promise.all([
      Promise.race([
        server.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
      Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]),
    ])
  }
}

export { createWorkflowLintReport }
export type { WorkflowLintIssue, WorkflowLintReport }
