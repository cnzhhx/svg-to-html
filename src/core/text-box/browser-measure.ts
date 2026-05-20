import { evaluatePage } from '../cdp.js'

import { type HtmlTextBlock } from './types.js'

export const readHtmlTextBlocks = ({
  designHeight,
  designWidth,
  htmlUrl,
  port,
}: {
  designHeight: number
  designWidth: number
  htmlUrl: string
  port: number
}) =>
  evaluatePage<HtmlTextBlock[]>({
    expression: `(() => {
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

      const toBox = (rect, rootRect) => ({
        x: Number((rect.left - rootRect.left).toFixed(3)),
        y: Number((rect.top - rootRect.top).toFixed(3)),
        width: Number(rect.width.toFixed(3)),
        height: Number(rect.height.toFixed(3)),
      })

      const groupLineRects = (rects) => {
        const groups = []

        rects.forEach((rect) => {
          const lastGroup = groups[groups.length - 1]
          if (!lastGroup || Math.abs(lastGroup.top - rect.y) > 1) {
            groups.push({
              left: rect.x,
              right: rect.x + rect.width,
              top: rect.y,
              bottom: rect.y + rect.height,
            })
            return
          }

          lastGroup.left = Math.min(lastGroup.left, rect.x)
          lastGroup.right = Math.max(lastGroup.right, rect.x + rect.width)
          lastGroup.top = Math.min(lastGroup.top, rect.y)
          lastGroup.bottom = Math.max(lastGroup.bottom, rect.y + rect.height)
        })

        return groups.map((group) => ({
          x: Number(group.left.toFixed(3)),
          y: Number(group.top.toFixed(3)),
          width: Number((group.right - group.left).toFixed(3)),
          height: Number((group.bottom - group.top).toFixed(3)),
        }))
      }

      const unionBoxes = (boxes) => {
        if (!boxes.length) return null

        let minX = Number.POSITIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxX = Number.NEGATIVE_INFINITY
        let maxY = Number.NEGATIVE_INFINITY

        boxes.forEach((box) => {
          minX = Math.min(minX, box.x)
          minY = Math.min(minY, box.y)
          maxX = Math.max(maxX, box.x + box.width)
          maxY = Math.max(maxY, box.y + box.height)
        })

        return {
          x: Number(minX.toFixed(3)),
          y: Number(minY.toFixed(3)),
          width: Number((maxX - minX).toFixed(3)),
          height: Number((maxY - minY).toFixed(3)),
        }
      }

      const readInlineConfig = () => {
        const node = document.querySelector('script[data-text-layout-config]')
        if (!(node instanceof HTMLScriptElement)) return { blocks: [] }

        try {
          const parsed = JSON.parse(node.textContent ?? '{}')
          return parsed && typeof parsed === 'object'
            ? parsed
            : { blocks: [] }
        } catch {
          return { blocks: [] }
        }
      }

      const groupRegionRows = (boxes) => {
        const sorted = [...boxes].sort((left, right) => left.y - right.y || left.x - right.x)
        const rows = []

        sorted.forEach((box) => {
          const lastRow = rows[rows.length - 1]
          const maxDeltaY = Math.max(
            8,
            Math.min(
              box.height,
              lastRow ? lastRow.height : box.height,
            ) * 0.6,
          )
          if (!lastRow || Math.abs(lastRow.y - box.y) > maxDeltaY) {
            rows.push({ ...box })
            return
          }

          const merged = unionBoxes([lastRow, box])
          if (!merged) return
          lastRow.x = merged.x
          lastRow.y = merged.y
          lastRow.width = merged.width
          lastRow.height = merged.height
        })

        return rows
      }

      const layoutConfig = readInlineConfig()
      const trackedLayoutBlocks = (layoutConfig.blocks ?? [])
        .filter((block) => block && Array.isArray(block.selectors) && block.region)
        .map((block) => ({
          id: block.id ?? '',
          region: {
            x: Number(block.region.x),
            y: Number(block.region.y),
            width: Number(block.region.width),
            height: Number(block.region.height),
          },
          selectors: block.selectors.filter((selector) => typeof selector === 'string'),
        }))

      const measureInkBox = ({ elementBox, style, text }) => {
        const fontSizePx = parsePx(style.fontSize)
        if (fontSizePx <= 0 || !text) return null

        const canvas = document.createElement('canvas')
        canvas.width = 1200
        canvas.height = 400
        const ctx = canvas.getContext('2d')
        if (!ctx) return null

        ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily
        ctx.textBaseline = 'alphabetic'

        const metrics = ctx.measureText(text)
        const actualLeft = Number(metrics.actualBoundingBoxLeft ?? NaN)
        const actualRight = Number(metrics.actualBoundingBoxRight ?? NaN)
        const actualAscent = Number(metrics.actualBoundingBoxAscent ?? NaN)
        const actualDescent = Number(metrics.actualBoundingBoxDescent ?? NaN)
        const fontAscent = Number(metrics.fontBoundingBoxAscent ?? NaN)
        const fontDescent = Number(metrics.fontBoundingBoxDescent ?? NaN)

        if (
          !Number.isFinite(actualLeft) ||
          !Number.isFinite(actualRight) ||
          !Number.isFinite(actualAscent) ||
          !Number.isFinite(actualDescent)
        ) {
          return null
        }

        const paddingLeft = parsePx(style.paddingLeft)
        const paddingRight = parsePx(style.paddingRight)
        const borderLeft = parsePx(style.borderLeftWidth)
        const borderRight = parsePx(style.borderRightWidth)
        const contentLeft = elementBox.x + paddingLeft + borderLeft
        const contentWidth = Math.max(
          0,
          elementBox.width - paddingLeft - paddingRight - borderLeft - borderRight,
        )
        const advanceWidth = Number.isFinite(metrics.width) ? metrics.width : actualLeft + actualRight
        const textAlign = style.textAlign
        let anchorX = contentLeft
        if (textAlign === 'center') {
          anchorX = contentLeft + Math.max(0, (contentWidth - advanceWidth) / 2)
        } else if (textAlign === 'right' || textAlign === 'end') {
          anchorX = contentLeft + Math.max(0, contentWidth - advanceWidth)
        }

        const lineHeightPx = parsePx(style.lineHeight) || fontSizePx
        let glyphTopOffset = 0

        if (Number.isFinite(fontAscent) && Number.isFinite(fontDescent)) {
          const baselineFromTop =
            (lineHeightPx - (fontAscent + fontDescent)) / 2 + fontAscent
          glyphTopOffset = baselineFromTop - actualAscent
        } else {
          glyphTopOffset = Math.max(0, lineHeightPx - (actualAscent + actualDescent)) / 2
        }

        return {
          x: Number((anchorX - actualLeft).toFixed(3)),
          y: Number((elementBox.y + glyphTopOffset).toFixed(3)),
          width: Number((actualLeft + actualRight).toFixed(3)),
          height: Number((actualAscent + actualDescent).toFixed(3)),
        }
      }

      const shouldUseInkBox = ({ hasChildElements, lineBoxes, style, text }) => {
        // Canvas ink metrics are only trusted for short atomic tokens; longer
        // text and composed DOM should stay with browser range geometry.
        if (hasChildElements || lineBoxes.length !== 1) return false
        if (!style.whiteSpace.includes('nowrap')) return false
        const compactText = normalizeText(text)
        if (!compactText || compactText.length > 12) return false

        const containsCjk = /[\u3400-\u9fff]/.test(compactText)
        const pureNumericToken =
          /^[-+]?[$¥￥]?\d+(?:[.,:]\d+)*%?$/.test(compactText) ||
          /^[-+]?[$¥￥]?(?:\d+(?:[.,:]\d+)*%?)?(?:元|天|小时|分|秒)$/.test(compactText)
        const compactSymbolToken = /^[-+]?[$¥￥]$/.test(compactText)
        const shortUnitToken =
          compactText.length <= 3 &&
          /^[-+]?[$¥￥]?(?:\d+)?(?:元|天|时|分|秒)$/.test(compactText)
        const plainNumericToken = /^[-+]?[$¥￥]?\d+(?:[.,:]\d+)*$/.test(compactText)

        if (containsCjk) return shortUnitToken

        return compactSymbolToken || (compactText.length <= 8 && (pureNumericToken || plainNumericToken))
      }

      const rootRect = document.body.getBoundingClientRect()
      const elements = [...document.body.querySelectorAll('*')]
      const infos = elements
        .map((element) => {
          if (!(element instanceof HTMLElement)) return null
          const text = normalizeText(element.textContent ?? '')
          if (!text) return null

          const style = window.getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden') return null

          const elementRect = element.getBoundingClientRect()
          if (elementRect.width <= 0 || elementRect.height <= 0) return null

          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                return normalizeText(node.textContent ?? '')
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT
              },
            },
          )

          const textNodes = []
          while (walker.nextNode()) {
            if (walker.currentNode instanceof Text) textNodes.push(walker.currentNode)
          }
          if (!textNodes.length) return null

          const range = document.createRange()
          const lastNode = textNodes[textNodes.length - 1]
          range.setStart(textNodes[0], 0)
          range.setEnd(lastNode, lastNode.data.length)

          const rawRects = [...range.getClientRects()]
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => toBox(rect, rootRect))
          const elementBox = toBox(elementRect, rootRect)
          const whiteSpace = style.whiteSpace
          const measuredLineBoxes = groupLineRects(rawRects)
          const measuredTextBox = unionBoxes(measuredLineBoxes)
          if (!measuredLineBoxes.length || !measuredTextBox) return null

          const lineBoxes = whiteSpace.includes('nowrap')
            ? [elementBox]
            : measuredLineBoxes

          const childElements = [...element.children].filter((child) =>
            child instanceof HTMLElement,
          )
          const childTextElements = childElements.filter((child) => {
            if (!(child instanceof HTMLElement)) return false
            return normalizeText(child.textContent ?? '').length > 0
          })
          const hasOnlyLineBreakChildren =
            childElements.length > 0 &&
            childElements.every((child) => child.tagName === 'BR')
          const containerDisplay = style.display
          const hasOnlyInlineChildren =
            childTextElements.length > 0 &&
            childTextElements.every((child) => {
              const childDisplay = window.getComputedStyle(child).display
              return ['inline', 'inline-block', 'contents'].includes(childDisplay)
            })

          const areaRatio =
            elementBox.width * elementBox.height /
            Math.max(1, measuredTextBox.width * measuredTextBox.height)
          const insetLeft = Math.abs(measuredTextBox.x - elementBox.x)
          const insetTop = Math.abs(measuredTextBox.y - elementBox.y)
          const insetRight = Math.abs(
            elementBox.x + elementBox.width - (measuredTextBox.x + measuredTextBox.width),
          )
          const insetBottom = Math.abs(
            elementBox.y + elementBox.height - (measuredTextBox.y + measuredTextBox.height),
          )
          const isTightTextContainer =
            Math.max(insetLeft, insetTop, insetRight, insetBottom) <= 8 &&
            areaRatio <= 1.8
          const isMixedInlineRoot =
            hasOnlyInlineChildren &&
            whiteSpace.includes('nowrap') &&
            elementBox.width <= 480 &&
            elementBox.height <= 100
          // Inline/flex roots can be the semantic text group even when their
          // descendants produce the measurable glyph rectangles.
          const isGroupedFlexRoot =
            childTextElements.length > 0 &&
            ['flex', 'inline-flex'].includes(containerDisplay) &&
            elementBox.width <= 480 &&
            elementBox.height <= 100 &&
            (
              isTightTextContainer ||
              Math.max(insetLeft, insetTop, insetRight, insetBottom) <= 20
            )
          const isMultilineBreakRoot =
            hasOnlyLineBreakChildren &&
            lineBoxes.length > 1 &&
            isTightTextContainer
          const supportsDescendantTrackedRegions =
            isMixedInlineRoot ||
            isGroupedFlexRoot ||
            isMultilineBreakRoot ||
            lineBoxes.length > 1

          const prefersInkBox = shouldUseInkBox({
            hasChildElements: element.children.length > 0,
            lineBoxes,
            style,
            text,
          })
          const inkBox =
            prefersInkBox
              ? measureInkBox({
                  elementBox,
                  style,
                  text,
                })
              : null
          const preferMeasuredTextBox =
            !inkBox &&
            whiteSpace.includes('nowrap') &&
            measuredLineBoxes.length === 1 &&
            (
              ['flex', 'inline-flex'].includes(containerDisplay) ||
              areaRatio >= 1.8 ||
              Math.max(insetLeft, insetTop, insetRight, insetBottom) >= 10
            )
          const compareLineBoxes = inkBox
            ? [inkBox]
            : preferMeasuredTextBox
              ? measuredLineBoxes
              : lineBoxes
          const compareBox = inkBox
            ? inkBox
            : preferMeasuredTextBox
              ? measuredTextBox
              : elementBox
          const directTrackedBlocks = trackedLayoutBlocks.filter((block) =>
            block.selectors.some((selector) => {
              try {
                return element.matches(selector)
              } catch {
                return false
              }
            }),
          )
          const descendantTrackedBlocks =
            directTrackedBlocks.length || !supportsDescendantTrackedRegions
              ? []
              : trackedLayoutBlocks.filter((block) =>
                  block.selectors.some((selector) => {
                    try {
                      return element.querySelector(selector) instanceof Element
                    } catch {
                      return false
                    }
                  }),
                )
          const trackedBlocksForElement =
            directTrackedBlocks.length > 0
              ? directTrackedBlocks
              : descendantTrackedBlocks
          const configLineBoxes = groupRegionRows(
            trackedBlocksForElement.map((block) => block.region),
          )
          const configExpectedBox = unionBoxes(configLineBoxes)

          return {
            box: compareBox,
            boxBasis: inkBox ? 'ink-box' : 'element-box',
            configBlockIds: trackedBlocksForElement.map((block) => block.id),
            configExpectedBox,
            configLineBoxes,
            element,
            elementSelector: buildNodePath(element),
            hasChildElements: element.children.length > 0,
            isMixedInlineRoot:
              isMixedInlineRoot ||
              isGroupedFlexRoot ||
              isMultilineBreakRoot ||
              (hasOnlyInlineChildren && isTightTextContainer),
            lineBoxes: compareLineBoxes,
            matchMode: inkBox ? 'single-path' : 'row',
            rawBox: elementBox,
            text,
          }
        })
        .filter(Boolean)

      const mixedInlineRoots = infos
        .filter((item) => item.isMixedInlineRoot)
        .map((item) => item.element)

      return infos
        .filter((item) => {
          if (item.isMixedInlineRoot) return true
          if (item.hasChildElements) return false

          let parent = item.element.parentElement
          while (parent) {
            if (mixedInlineRoots.includes(parent)) return false
            parent = parent.parentElement
          }

          return true
        })
        .map((item) => ({
          box: item.box,
          boxBasis: item.boxBasis,
          configBlockIds: item.configBlockIds,
          configExpectedBox: item.configExpectedBox,
          configLineBoxes: item.configLineBoxes,
          elementSelector: item.elementSelector,
          lineBoxes: item.lineBoxes,
          matchMode: item.matchMode,
          rawBox: item.rawBox,
          text: item.text,
        }))
    })()`,
    port,
    readyExpression:
      '(async () => { if (document.readyState !== "complete") return false; if (document.fonts) await document.fonts.ready; return true })()',
    url: htmlUrl,
    viewportHeight: designHeight,
    viewportWidth: designWidth,
  })
