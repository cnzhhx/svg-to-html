import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { OutputFormat, SessionOutputTarget } from './output-target.js'
import { resolveOutputTarget } from './output-target.js'
import { resolveSvgDesign } from './design-resolve.js';
import { writeTextFile } from './file-io.js';

const createRenderScaffold = ({
  designName,
  height,
  width,
}: {
  designName: string
  height: number
  width: number
}) => {
  const formatPx = (value: number) => `${Math.round(value)}px`
  const widthPx = formatPx(width)
  const heightPx = formatPx(height)

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${designName}</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: transparent;
        font-family: "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
      }

      .design-page {
        position: relative;
        width: ${widthPx};
        height: ${heightPx};
        overflow: hidden;
        background: transparent;
      }
    </style>
  </head>
  <body>
    <main class="design-page">
      <!-- Rebuild this page from the target SVG source with real DOM/CSS. -->
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
  renderEntryFileName,
  svgFileName,
  width,
}: {
  designName: string
  height: number
  renderEntryFileName: string
  svgFileName: string
  width: number
}) => {
  const formatPx = (value: number) => `${Math.round(value)}px`
  const widthPx = formatPx(width)
  const heightPx = formatPx(height)

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${designName} 对照</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 24px 0;
        overflow-x: auto;
        background: transparent;
        font-family: "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
      }

      .compare-shell {
        display: flex;
        gap: 24px;
        width: max-content;
        margin: 0 auto;
        padding: 0 24px;
      }

      .compare-column {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .compare-title {
        color: #c99100;
        font-size: 18px;
        line-height: 26px;
        letter-spacing: 2px;
      }

      .compare-stage {
        width: ${widthPx};
        height: ${heightPx};
        overflow: hidden;
        background: transparent;
        box-shadow: 0 0 0 1px rgba(255, 224, 170, 0.18);
      }

      .compare-stage img,
      .compare-stage iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
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
          <iframe src="./${renderEntryFileName}" title="${designName} 代码还原"></iframe>
        </div>
      </section>
    </main>
  </body>
</html>
`
}

const createVueSourceScaffold = ({
  height,
  width,
}: {
  height: number
  width: number
}) => `\
<template>
  <main class="design-page">
  </main>
</template>

<script setup lang="ts">
</script>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  margin: 0;
  min-height: 100%;
}

:global(*) {
  box-sizing: border-box;
}

:global(body) {
  background: transparent;
  font-family: "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
}

.design-page {
  position: relative;
  width: ${Math.round(width)}px;
  height: ${Math.round(height)}px;
  overflow: hidden;
  background: transparent;
}
</style>
`

const createReactSourceScaffold = ({
  designName,
}: {
  designName: string
}) => `\
import "./${designName}.css";

export default function DesignPage() {
  return <main className="design-page" />;
}
`

const createReactStyleScaffold = ({
  height,
  width,
}: {
  height: number
  width: number
}) => `\
* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  min-height: 100%;
}

body {
  background: transparent;
  font-family: "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
}

.design-page {
  position: relative;
  width: ${Math.round(width)}px;
  height: ${Math.round(height)}px;
  overflow: hidden;
  background: transparent;
}
`

const writeIfMissing = async ({
  content,
  overwrite,
  path: filePath,
}: {
  content: string
  overwrite: boolean
  path: string
}) => {
  let exists = false
  try {
    await stat(filePath)
    exists = true
  } catch {}

  if (!exists || overwrite) await writeTextFile(filePath, content)
}

const initializeRenderScaffold = async ({
  content,
  designName,
  height,
  outputTarget,
  overwrite = false,
  width,
}: {
  content?: string
  designName: string
  height: number
  outputTarget: SessionOutputTarget
  overwrite?: boolean
  width: number
}) => {
  await writeIfMissing({
    content:
      content ??
      createRenderScaffold({
        designName,
        height,
        width,
      }),
    overwrite,
    path: outputTarget.renderEntryPath,
  })
}

const initializeSourceScaffold = async ({
  designName,
  format,
  height,
  outputTarget,
  overwrite = false,
  width,
}: {
  designName: string
  format: OutputFormat
  height: number
  outputTarget: SessionOutputTarget
  overwrite?: boolean
  width: number
}) => {
  if (format === 'html') return
  if (format === 'vue') {
    await writeIfMissing({
      content: createVueSourceScaffold({ height, width }),
      overwrite,
      path: outputTarget.sourceEntryPath,
    })
    return
  }

  await writeIfMissing({
    content: createReactSourceScaffold({ designName }),
    overwrite,
    path: outputTarget.sourceEntryPath,
  })
  if (outputTarget.sourceStylePath) {
    await writeIfMissing({
      content: createReactStyleScaffold({ height, width }),
      overwrite,
      path: outputTarget.sourceStylePath,
    })
  }
}

const initializeDesignScaffolds = async ({
  format,
  renderContent,
  inputPath,
  overwrite = false,
  scale,
}: {
  format: OutputFormat
  inputPath: string
  overwrite?: boolean
  renderContent?: string
  scale?: number
}) => {
  const design = await resolveSvgDesign(inputPath, { scale })
  const outputTarget = resolveOutputTarget({ format, svgPath: design.svgPath })

  await initializeRenderScaffold({
    content: renderContent,
    designName: design.designName,
    height: design.height,
    outputTarget,
    overwrite,
    width: design.width,
  })
  await initializeSourceScaffold({
    designName: design.designName,
    format,
    height: design.height,
    outputTarget,
    overwrite,
    width: design.width,
  })

  await writeTextFile(
    outputTarget.compareEntryPath,
    createCompareScaffold({
      designName: design.designName,
      height: design.height,
      renderEntryFileName: path.basename(outputTarget.renderEntryPath),
      svgFileName: `${design.designName}.svg`,
      width: design.width,
    }),
  )

  return {
    ...design,
    outputFormat: format,
    outputTarget,
  }
}

export { initializeDesignScaffolds }
