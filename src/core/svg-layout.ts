import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "./cdp.js";
import { type Box, ensureSvgViewBox, type ResolvedSvgDesign, writeTextFile } from "./utils.js";

type SvgLayoutNode = {
  attributes: Record<string, string>;
  childCount: number;
  depth: number;
  nodePath: string;
  parentPath: null | string;
  pixelBox: Box | null;
  siblingIndex: number;
  tag: string;
  textContent?: string;
  viewBoxBox: Box | null;
  visibleBox?: Box | null;
};

type SvgLayoutResult = {
  nodeCount: number;
  nodes: SvgLayoutNode[];
  scale: { x: number; y: number };
  svgViewBox: Box;
  visibleBoxDebug?: {
    errors: string[];
    stats: {
      attempted: number;
      clipAncestors: number;
      clipNodes: number;
      clipBoxes: number;
      set: number;
    };
  };
};

const createWrapper = ({
  height,
  svgMarkup,
  width,
}: {
  height: number;
  svgMarkup: string;
  width: number;
}) => `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: transparent;
      }

      svg {
        display: block;
        width: ${width}px;
        height: ${height}px;
      }
    </style>
  </head>
  <body>
    ${svgMarkup}
    <script>
      window.__RENDER_READY__ = true
    </script>
  </body>
</html>
`;

const readSvgLayout = async ({
  design,
  svgMarkup,
  wrapperName = "svg-layout-source.html",
  wrapperRoot,
}: {
  design: ResolvedSvgDesign;
  svgMarkup?: string;
  wrapperName?: string;
  wrapperRoot: string;
}): Promise<{ result: SvgLayoutResult; wrapperPath: string }> => {
  const wrapperPath = path.join(wrapperRoot, wrapperName);
  const resolvedSvgMarkup = ensureSvgViewBox(
    svgMarkup ?? (await readFile(design.svgPath, "utf8")),
  );

  await writeTextFile(
    wrapperPath,
    createWrapper({
      height: design.height,
      svgMarkup: resolvedSvgMarkup,
      width: design.width,
    }),
  );

  const browser = await launchEdge();

  try {
    const result = await evaluatePage<SvgLayoutResult>({
      deviceScaleFactor: design.scale,
      expression: `(() => {
        const root = document.querySelector('svg')
        if (!(root instanceof SVGSVGElement)) throw new Error('SVG root not found')

        const rawViewBox = root.viewBox.baseVal
        const rect = root.getBoundingClientRect()
        const viewBox =
          rawViewBox.width > 0 && rawViewBox.height > 0
            ? rawViewBox
            : {
                x: 0,
                y: 0,
                width: rect.width,
                height: rect.height,
              }
        const scale = {
          x: Number((rect.width / Math.max(1, viewBox.width)).toFixed(6)),
          y: Number((rect.height / Math.max(1, viewBox.height)).toFixed(6)),
        }

        const buildNodePath = (node) => {
          const segments = []
          let current = node

          while (current && current instanceof SVGElement) {
            const parent = current.parentElement
            const tag = current.tagName.toLowerCase()
            const siblings = parent
              ? [...parent.children].filter((item) => item.tagName === current.tagName)
              : [current]
            const index = siblings.indexOf(current) + 1
            segments.unshift(\`\${tag}:nth-of-type(\${index})\`)
            if (current === root) break
            current = parent
          }

          return segments.join(' > ')
        }

        const readAttributes = (node) => {
          const names = [
            'id',
            'class',
            'display',
            'fill',
            'fill-opacity',
            'visibility',
            'stroke',
            'stroke-opacity',
            'opacity',
            'transform',
            'x',
            'y',
            'width',
            'height',
            'rx',
            'ry',
            'href',
            'xlink:href',
            'viewBox',
            'font-size',
            'font-family',
            'font-weight',
            'letter-spacing',
            'text-anchor',
            'dominant-baseline',
            'mask',
            'clip-path',
            'filter',
          ]
          const output = {}

          names.forEach((name) => {
            const value = node.getAttribute(name)
            if (value) output[name] = value
          })

          if (node.tagName.toLowerCase() === 'path') {
            output.pathDataLength = String(node.getAttribute('d')?.length ?? 0)
          }

          // Also read computed font styles for text/tspan elements
          const tag = node.tagName.toLowerCase()
          if (tag === 'text' || tag === 'tspan') {
            try {
              const computed = window.getComputedStyle(node)
              if (computed.fontSize) output['computed-font-size'] = computed.fontSize
              if (computed.fontFamily) output['computed-font-family'] = computed.fontFamily
              if (computed.fontWeight) output['computed-font-weight'] = computed.fontWeight
              if (computed.letterSpacing && computed.letterSpacing !== 'normal')
                output['computed-letter-spacing'] = computed.letterSpacing
            } catch {}
          }

          return output
        }

        const toPixelBox = (clientRect) => {
          if (!clientRect || (!clientRect.width && !clientRect.height)) return null

          const clippedLeft = Math.max(rect.left, clientRect.left)
          const clippedTop = Math.max(rect.top, clientRect.top)
          const clippedRight = Math.min(rect.right, clientRect.right)
          const clippedBottom = Math.min(rect.bottom, clientRect.bottom)
          const clippedWidth = clippedRight - clippedLeft
          const clippedHeight = clippedBottom - clippedTop

          if (!(clippedWidth > 0 && clippedHeight > 0)) return null

          return {
            x: Number((clippedLeft - rect.left).toFixed(3)),
            y: Number((clippedTop - rect.top).toFixed(3)),
            width: Number(clippedWidth.toFixed(3)),
            height: Number(clippedHeight.toFixed(3)),
          }
        }

        const toViewBoxBox = (pixelBox) =>
          !pixelBox
            ? null
            : {
                x: Number((viewBox.x + pixelBox.x / Math.max(0.000001, scale.x)).toFixed(3)),
                y: Number((viewBox.y + pixelBox.y / Math.max(0.000001, scale.y)).toFixed(3)),
                width: Number((pixelBox.width / Math.max(0.000001, scale.x)).toFixed(3)),
                height: Number((pixelBox.height / Math.max(0.000001, scale.y)).toFixed(3)),
              }

        const walk = (node, depth, parentPath) => {
          if (!(node instanceof SVGElement)) return []

          let pixelBox = null
          try {
            pixelBox = toPixelBox(node.getBoundingClientRect())
          } catch {}

          const nodePath = buildNodePath(node)
          const parent = node.parentElement
          const siblings = parent
            ? [...parent.children].filter((item) => item.tagName === node.tagName)
            : [node]
          const current = {
            attributes: readAttributes(node),
            childCount: [...node.children].filter((child) => child instanceof SVGElement).length,
            depth,
            nodePath,
            parentPath,
            pixelBox,
            siblingIndex: siblings.indexOf(node) + 1,
            tag: node.tagName.toLowerCase(),
            textContent: (['text', 'tspan'].includes(node.tagName.toLowerCase()) && node.textContent?.trim())
              ? node.textContent.trim()
              : undefined,
            viewBoxBox: toViewBoxBox(pixelBox),
            visibleBox: null,
          }

          const descendants = [...node.children].flatMap((child) =>
            walk(child, depth + 1, nodePath),
          )
          return [current, ...descendants]
        }

        const nodes = walk(root, 0, null)

        const computeVisibleBoxes = (allNodes, svgRoot, debug) => {
          const nodeByPath = new Map(allNodes.map((n) => [n.nodePath, n]))
          const parentOf = new Map()
          for (const n of allNodes) {
            if (n.parentPath) parentOf.set(n.nodePath, n.parentPath)
          }
          // Build clipPath lookup directly from DOM since clipPath elements have
          // empty bounding boxes and are skipped by walk()
          const clipPathEls = new Map()
          try {
            svgRoot.querySelectorAll('clipPath').forEach((el) => {
              const id = el.getAttribute('id')
              if (id) clipPathEls.set(id, el)
            })
          } catch {}
          try {
            svgRoot.querySelectorAll('mask').forEach((el) => {
              const id = el.getAttribute('id')
              if (id) clipPathEls.set(id, el)
            })
          } catch {}
          const findClipAncestor = (nodePath) => {
            let current = nodePath
            while (current) {
              const parentPath = parentOf.get(current)
              if (!parentPath) break
              const parent = nodeByPath.get(parentPath)
              if (!parent) break
              if (parent.attributes['clip-path'] || parent.attributes['mask']) {
                return parent
              }
              current = parentPath
            }
            return null
          }
          const parseRef = (value) => {
            if (typeof value !== 'string') return null
            const idx1 = value.indexOf('url(#')
            if (idx1 !== -1) {
              const idx2 = value.indexOf(')', idx1 + 5)
              if (idx2 !== -1) return value.slice(idx1 + 5, idx2)
            }
            if (value.charAt(0) === '#') return value.slice(1)
            return null
          }
          const computeClipBox = (clipAncestorNode, clipId) => {
            const clipPathEl = clipPathEls.get(clipId)
            if (!clipPathEl) return null
            const rectEl = clipPathEl.querySelector('rect')
            let x, y, w, h
            if (rectEl) {
              x = parseFloat(rectEl.getAttribute('x') || '0')
              y = parseFloat(rectEl.getAttribute('y') || '0')
              w = parseFloat(rectEl.getAttribute('width') || '0')
              h = parseFloat(rectEl.getAttribute('height') || '0')
              const transform = rectEl.getAttribute('transform') || ''
              const tIdx = transform.indexOf('translate(')
              if (tIdx !== -1) {
                const tEnd = transform.indexOf(')', tIdx + 10)
                if (tEnd !== -1) {
                  const tArgs = transform.slice(tIdx + 10, tEnd).trim().split(/[\s,]+/)
                  x += parseFloat(tArgs[0] || '0')
                  y += parseFloat(tArgs[1] || '0')
                }
              } else if (transform && !/^\s*$/.test(transform)) {
                return null
              }
            } else if (
              clipPathEl.tagName.toLowerCase() === 'mask' &&
              clipPathEl.getAttribute('width') &&
              clipPathEl.getAttribute('height')
            ) {
              // Fallback: use mask element's own x/y/width/height (userSpaceOnUse)
              x = parseFloat(clipPathEl.getAttribute('x') || '0')
              y = parseFloat(clipPathEl.getAttribute('y') || '0')
              w = parseFloat(clipPathEl.getAttribute('width') || '0')
              h = parseFloat(clipPathEl.getAttribute('height') || '0')
            } else {
              return null
            }
            if (!(w > 0 && h > 0)) return null
            const refEl = document.querySelector(clipAncestorNode.nodePath)
            if (!refEl) return null
            const refCTM = svgRoot.getCTM()
            if (!refCTM) return null
            const p1 = svgRoot.createSVGPoint()
            const p2 = svgRoot.createSVGPoint()
            p1.x = x
            p1.y = y
            p2.x = x + w
            p2.y = y + h
            const sp1 = p1.matrixTransform(refCTM)
            const sp2 = p2.matrixTransform(refCTM)
            const result = {
              x: Number(Math.min(sp1.x, sp2.x).toFixed(3)),
              y: Number(Math.min(sp1.y, sp2.y).toFixed(3)),
              width: Number(Math.abs(sp2.x - sp1.x).toFixed(3)),
              height: Number(Math.abs(sp2.y - sp1.y).toFixed(3)),
            }
            if (result.width <= 0 || result.height <= 0) return null
            return result
          }
          for (const node of allNodes) {
            if (!node.pixelBox) continue
            const clipAncestor = findClipAncestor(node.nodePath)
            if (!clipAncestor) continue
            const ref =
              clipAncestor.attributes['clip-path'] || clipAncestor.attributes['mask']
            const clipId = parseRef(ref)
            if (!clipId) continue
            const clipPathEl = clipPathEls.get(clipId)
            if (!clipPathEl) continue
            const clipBox = computeClipBox(clipAncestor, clipId)
            if (!clipBox) continue
            const px = node.pixelBox
            const ix = Math.max(px.x, clipBox.x)
            const iy = Math.max(px.y, clipBox.y)
            const iw = Math.min(px.x + px.width, clipBox.x + clipBox.width) - ix
            const ih = Math.min(px.y + px.height, clipBox.y + clipBox.height) - iy
            if (iw > 0 && ih > 0) {
              if (iw * ih <= px.width * px.height + 1) {
                const areaDiff = Math.abs(px.width * px.height - iw * ih)
                if (areaDiff > 4) {
                  node.visibleBox = {
                    x: Number(ix.toFixed(3)),
                    y: Number(iy.toFixed(3)),
                    width: Number(iw.toFixed(3)),
                    height: Number(ih.toFixed(3)),
                  }
                }
              }
            }
          }
        }

        computeVisibleBoxes(nodes, root)

        return {
          nodeCount: nodes.length,
          nodes,
          scale,
          svgViewBox: {
            x: viewBox.x,
            y: viewBox.y,
            width: viewBox.width,
            height: viewBox.height,
          },
        }
      })()`,
      port: browser.port,
      url: pathToFileURL(wrapperPath).href,
      viewportHeight: design.height,
      viewportWidth: design.width,
    });

    return { result, wrapperPath };
  } finally {
    await browser.close();
  }
};

export type { SvgLayoutNode, SvgLayoutResult };
export { readSvgLayout };
