import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluatePage, launchEdge } from "./cdp.js";
import { type Box, type DesignPair, writeTextFile } from "./utils.js";

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
};

type SvgLayoutResult = {
  nodeCount: number;
  nodes: SvgLayoutNode[];
  scale: { x: number; y: number };
  svgViewBox: Box;
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
        background: #000;
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
  design: DesignPair;
  svgMarkup?: string;
  wrapperName?: string;
  wrapperRoot: string;
}): Promise<{ result: SvgLayoutResult; wrapperPath: string }> => {
  const wrapperPath = path.join(wrapperRoot, wrapperName);
  const resolvedSvgMarkup =
    svgMarkup ?? (await readFile(design.svgPath, "utf8"));

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
            'fill',
            'stroke',
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

        const toPixelBox = (clientRect) =>
          !clientRect || (!clientRect.width && !clientRect.height)
            ? null
            : {
                x: Number((clientRect.left - rect.left).toFixed(3)),
                y: Number((clientRect.top - rect.top).toFixed(3)),
                width: Number(clientRect.width.toFixed(3)),
                height: Number(clientRect.height.toFixed(3)),
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
          }

          const descendants = [...node.children].flatMap((child) =>
            walk(child, depth + 1, nodePath),
          )
          return [current, ...descendants]
        }

        const nodes = walk(root, 0, null)
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

export type { Box, SvgLayoutNode, SvgLayoutResult };
export { readSvgLayout };
