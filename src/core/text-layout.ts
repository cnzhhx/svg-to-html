import { readFile } from 'node:fs/promises'

import { toAbsolutePath, writeTextFile } from './utils.js'

type SelectorRule = {
  declarations: Record<string, string>
  selectors: string[]
}

type TextLayoutBlock = {
  declarations: Record<string, string>
  id: string
  region?: {
    height: number
    width: number
    x: number
    y: number
  }
  selectors: string[]
}

type TextLayoutConfig = {
  blocks?: TextLayoutBlock[]
  rules: SelectorRule[]
}

const INLINE_CONFIG_START =
  '<script type="application/json" data-text-layout-config>'
const INLINE_CONFIG_END = '</script>'
const INLINE_STYLE_START = '<style data-text-layout-generated>'
const INLINE_STYLE_END = '</style>'

const renderSelectorRule = ({ declarations, selectors }: SelectorRule) => {
  const declarationLines = Object.entries(declarations).map(
    ([name, value]) => `  ${name}: ${value};`,
  )

  return [`${selectors.join(', ')} {`, ...declarationLines, '}'].join('\n')
}

const renderTextLayoutCss = ({ blocks = [], rules }: TextLayoutConfig) => {
  const sections = [
    '/* Generated from the inline text-layout config via `pnpm task sync-text-layout@design`. */',
    '/* Do not edit manually. Update the inline config in this HTML instead. */',
    '',
  ]

  if (rules.length) sections.push(...rules.map(renderSelectorRule), '')

  if (blocks.length) {
    sections.push(
      '/* Block-level text overrides */',
      ...blocks.map(renderSelectorRule),
      '',
    )
  }

  return sections.join('\n')
}

const hasInlineConfig = (html: string) =>
  /<script type="application\/json" data-text-layout-config>\s*[\s\S]*?<\/script>/m.test(
    html,
  )

const extractInlineConfig = (html: string): TextLayoutConfig => {
  const match = html.match(
    /<script type="application\/json" data-text-layout-config>\s*([\s\S]*?)\s*<\/script>/m,
  )
  if (!match?.[1])
    throw new Error('Unable to locate inline text-layout config in target HTML')

  return JSON.parse(match[1]) as TextLayoutConfig
}

const injectInlineConfig = ({
  config,
  html,
}: {
  config: TextLayoutConfig
  html: string
}) => {
  const configJson = JSON.stringify(config, null, 2)
  const configBlock = `${INLINE_CONFIG_START}\n${configJson}\n    ${INLINE_CONFIG_END}`
  const existingPattern = new RegExp(
    `${INLINE_CONFIG_START}[\\s\\S]*?${INLINE_CONFIG_END}`,
    'm',
  )

  if (existingPattern.test(html))
    return html.replace(existingPattern, configBlock)
  if (!html.includes('</head>'))
    throw new Error('Unable to locate </head> in target HTML')

  return html.replace('</head>', `    ${configBlock}\n  </head>`)
}

const indentCss = (css: string) =>
  css
    .split('\n')
    .map((line) => `      ${line}`.trimEnd())
    .join('\n')

const injectInlineStyle = ({ css, html }: { css: string; html: string }) => {
  const inlineBlock = `${INLINE_STYLE_START}\n${indentCss(css)}\n    ${INLINE_STYLE_END}`
  const existingPattern = new RegExp(
    `${INLINE_STYLE_START}[\\s\\S]*?${INLINE_STYLE_END}`,
    'm',
  )

  if (existingPattern.test(html))
    return html.replace(existingPattern, inlineBlock)
  if (!html.includes('</head>'))
    throw new Error('Unable to locate </head> in target HTML')

  return html.replace('</head>', `    ${inlineBlock}\n  </head>`)
}

const syncInlineTextLayoutCss = (html: string) => {
  const config = extractInlineConfig(html)
  const css = renderTextLayoutCss(config)
  return injectInlineStyle({
    css,
    html,
  })
}

const syncInlineTextLayoutFile = async (inputPath: string) => {
  const htmlPath = toAbsolutePath(inputPath)
  const html = await readFile(htmlPath, 'utf8')
  const nextHtml = syncInlineTextLayoutCss(html)

  await writeTextFile(htmlPath, nextHtml)
}

export type { SelectorRule, TextLayoutBlock, TextLayoutConfig }
export {
  extractInlineConfig,
  hasInlineConfig,
  injectInlineConfig,
  injectInlineStyle,
  renderTextLayoutCss,
  syncInlineTextLayoutCss,
  syncInlineTextLayoutFile,
}
