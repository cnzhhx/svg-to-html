import type { DiffReport } from './types.js'

const renderDiffInsightsMarkdown = (report: DiffReport) =>
  [
    '# Diff Insights',
    '',
    `- diffRatio: ${report.diffRatio}`,
    `- diffPixels: ${report.diffPixels}/${report.totalPixels}`,
    `- averageChannelDelta: ${report.averageChannelDelta}`,
    report.boundingBox
      ? `- boundingBox: x=${report.boundingBox.x}, y=${report.boundingBox.y}, w=${report.boundingBox.width}, h=${report.boundingBox.height}`
      : '- boundingBox: none',
    '',
    '## Agent Hints',
    ...(report.agentHints.length
      ? report.agentHints.map((hint) => `- ${hint.summary}`)
      : ['- no major hint']),
    '',
    '## Hairline Hotspots',
    ...(report.hairlineHotspots.length
      ? report.hairlineHotspots.map(
          (hotspot, index) =>
            `- hairline-${index + 1}: y=${hotspot.start}~${hotspot.end}, height=${hotspot.height}, coverage=${hotspot.coverageRatio}, averageChannelDelta=${hotspot.averageChannelDelta}, note=below-default-threshold(${report.threshold})`,
        )
      : ['- none']),
    '',
    '## Top Clusters',
    ...(report.clusters.length
      ? report.clusters.map(
          (cluster) =>
            `- ${cluster.id}: x=${cluster.boundingBox.x}, y=${cluster.boundingBox.y}, w=${cluster.boundingBox.width}, h=${cluster.boundingBox.height}, diffPixels=${cluster.diffPixels}, diffRatioWithinBounds=${cluster.diffRatioWithinBounds}, averageChannelDelta=${cluster.averageChannelDelta}, luma=${cluster.dominantLumaTrend}, alpha=${cluster.dominantAlphaTrend}`,
        )
      : ['- none']),
    '',
    '## Horizontal Bands',
    ...(report.horizontalBands.length
      ? report.horizontalBands.map(
          (band) =>
            `- ${band.id}: y=${band.start}~${band.end}, diffRatio=${band.diffRatio}, diffPixels=${band.diffPixels}, averageChannelDelta=${band.averageChannelDelta}`,
        )
      : ['- none']),
    '',
    '## Vertical Bands',
    ...(report.verticalBands.length
      ? report.verticalBands.map(
          (band) =>
            `- ${band.id}: x=${band.start}~${band.end}, diffRatio=${band.diffRatio}, diffPixels=${band.diffPixels}, averageChannelDelta=${band.averageChannelDelta}`,
        )
      : ['- none']),
    '',
    '## Grid Hotspots',
    ...(report.gridHotspots.length
      ? report.gridHotspots.map(
          (cell) =>
            `- row=${cell.row}, column=${cell.column}, x=${cell.x}, y=${cell.y}, w=${cell.width}, h=${cell.height}, diffRatio=${cell.diffRatio}, diffPixels=${cell.diffPixels}, averageChannelDelta=${cell.averageChannelDelta}`,
        )
      : ['- none']),
    '',
  ].join('\n')

export { renderDiffInsightsMarkdown }
