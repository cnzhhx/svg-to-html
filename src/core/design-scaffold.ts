import { stat } from 'node:fs/promises'

import { syncInlineTextLayoutFile } from './text-layout.js'
import { resolveSvgDesign, writeTextFile } from './utils.js'

const createHtmlScaffold = ({
  designName,
  height,
  width,
}: {
  designName: string
  height: number
  width: number
}) => {
  const formatRem = (value: number) => value.toFixed(3)
  const widthRem = formatRem(width / 100)
  const heightRem = formatRem(height / 100)

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${designName}</title>
    <style>
      :root {
        font-size: 100px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: #000;
        font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }

      .design-page {
        position: relative;
        width: ${widthRem}rem;
        height: ${heightRem}rem;
        overflow: hidden;
        background: #000;
      }
    </style>
    <script type="application/json" data-text-layout-config>
{
  "rules": [],
  "blocks": []
}
    </script>
  </head>
  <body>
    <main class="design-page">
      <!-- Rebuild this page from the target SVG source with pure HTML/CSS. -->
      <!-- Do not copy structure or copywriting from src/, existing workspace/sessions/*/*.html, mocks, or any unverified agent output. -->
      <!-- Derive CSS linear-gradient direction from SVG x1/y1/x2/y2 and keep stop order aligned with the SVG stops. -->
      <!-- Do not hand-write guessed angles like 45deg/135deg/225deg for design gradients. -->
      <!-- Build a natural DOM tree from artifacts/container-layout.md and module summaries; do not scatter dozens of leaf nodes directly under .design-page. -->
      <!-- Do not blindly preserve SVG line breaks in HTML. If the content is semantically one continuous phrase, rebuild it as one text node and let the box width decide visual wrapping. -->
      <!-- Flattened single-node buttons/pills/cells must not keep old child-label padding, left text alignment, or manual text offsets. -->
    </main>
  </body>
</html>
`
}

const createCompareScaffold = ({
  designName,
  height,
  htmlFileName,
  svgFileName,
  width,
}: {
  designName: string
  height: number
  htmlFileName: string
  svgFileName: string
  width: number
}) => {
  const formatRem = (value: number) => value.toFixed(3)
  const widthRem = formatRem(width / 100)
  const heightRem = formatRem(height / 100)

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${designName} 对照</title>
    <style>
      :root {
        font-size: 100px;
        color-scheme: dark;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 0.240rem 0;
        overflow-x: auto;
        background: #000;
        font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }

      .compare-shell {
        display: flex;
        gap: 0.240rem;
        width: max-content;
        margin: 0 auto;
        padding: 0 0.240rem;
      }

      .compare-column {
        display: flex;
        flex-direction: column;
        gap: 0.120rem;
      }

      .compare-title {
        color: #c99100;
        font-size: 0.180rem;
        line-height: 0.260rem;
        letter-spacing: 0.020rem;
      }

      .compare-stage {
        width: ${widthRem}rem;
        height: ${heightRem}rem;
        overflow: hidden;
        background: #000;
        box-shadow: 0 0 0 0.010rem rgba(255, 224, 170, 0.18);
      }

      .compare-stage img,
      .compare-stage iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #000;
      }
    </style>
  </head>
  <body>
    <main class="compare-shell">
      <section class="compare-column">
        <div class="compare-title">高保真稿</div>
        <div class="compare-stage">
          <img src="./${svgFileName}" alt="${designName} 高保真稿" />
        </div>
      </section>

      <section class="compare-column">
        <div class="compare-title">代码还原</div>
        <div class="compare-stage">
          <iframe src="./${htmlFileName}" title="${designName} 代码还原"></iframe>
        </div>
      </section>
    </main>
  </body>
</html>
`
}

const initializeDesignScaffold = async ({
  htmlContent,
  inputPath,
  overwrite = false,
  scale,
}: {
  htmlContent?: string
  inputPath: string
  overwrite?: boolean
  scale?: number
}) => {
  const design = await resolveSvgDesign(inputPath, { scale })

  let htmlExists = false
  try {
    await stat(design.htmlPath)
    htmlExists = true
  } catch {}

  if (!htmlExists || overwrite) {
    await writeTextFile(
      design.htmlPath,
      htmlContent ??
        createHtmlScaffold({
          designName: design.designName,
          height: design.height,
          width: design.width,
        }),
    )
  }

  await syncInlineTextLayoutFile(design.htmlPath)

  await writeTextFile(
    design.compareHtmlPath,
    createCompareScaffold({
      designName: design.designName,
      height: design.height,
      htmlFileName: `${design.designName}.html`,
      svgFileName: `${design.designName}.svg`,
      width: design.width,
    }),
  )

  return design
}

export { initializeDesignScaffold }
