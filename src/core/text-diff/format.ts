import type { TextDiffIssue } from './types.js'

const formatTextIssueSummary = (issue: TextDiffIssue) => {
  const location = `x=${issue.region.x}, y=${issue.region.y}, w=${issue.region.width}, h=${issue.region.height}`
  if (issue.classification === 'no-text')
    return `区域 ${issue.id}(${location}) OCR 未识别到稳定文本。`

  if (issue.classification === 'html-missing') {
    const expectedBox = issue.svgBox
      ? ` SVG 文字框约 x=${issue.svgBox.x}, y=${issue.svgBox.y}, w=${issue.svgBox.width}, h=${issue.svgBox.height}。`
      : ''
    const buttonHint =
      issue.region.width >= 250 && issue.region.height <= 80
        ? ' 优先检查字号、字重、垂直居中和按钮底色对比度。'
        : ''
    return `区域 ${issue.id}(${location}) 疑似缺字；SVG="${issue.svgText}"，HTML 识别为空。${expectedBox}${buttonHint}`
  }
  if (issue.classification === 'html-extra')
    return `区域 ${issue.id}(${location}) 疑似多字；HTML="${issue.htmlText}"，SVG 识别为空。${issue.offset ? ` 文字块${issue.offset.summary}。` : ''}`

  if (issue.classification === 'partial-overlap')
    return `区域 ${issue.id}(${location}) 文本部分重合，可能是字号/位置/截断问题；similarity=${issue.similarity}；SVG="${issue.svgText}"，HTML="${issue.htmlText}"。${issue.offset ? ` 文字块${issue.offset.summary}。` : ''}`

  if (issue.classification === 'different')
    return `区域 ${issue.id}(${location}) 文本明显不一致；similarity=${issue.similarity}；SVG="${issue.svgText}"，HTML="${issue.htmlText}"。${issue.offset ? ` 文字块${issue.offset.summary}。` : ''}`

  return `区域 ${issue.id}(${location}) 文本基本一致；similarity=${issue.similarity}。${issue.offset ? ` 文字块${issue.offset.summary}。` : ''}`
}

export { formatTextIssueSummary }
