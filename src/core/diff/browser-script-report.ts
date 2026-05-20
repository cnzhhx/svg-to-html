const DIFF_BROWSER_REPORT_RUNTIME = String.raw`
  const agentHints = [
    ...topClusters.slice(0, 6).map((cluster, index) => ({
      kind: 'cluster',
      priority: index + 1,
      summary:
        '主要偏差块 #' +
        (index + 1) +
        ' 位于 ' +
        formatBox(cluster.boundingBox) +
        '；块内 diffRatio=' +
        cluster.diffRatioWithinBounds +
        '，平均通道差=' +
        cluster.averageChannelDelta +
        '；' +
        describeLumaTrend(cluster.dominantLumaTrend) +
        '，' +
        describeAlphaTrend(cluster.dominantAlphaTrend) +
        '。',
    })),
    ...hairlineHotspots.slice(0, 4).map((hotspot, index) => ({
      kind: 'hairline-y',
      priority: 50 + index,
      summary:
        '低对比横向细线候选 #' +
        (index + 1) +
        ' 位于 y=' +
        hotspot.start +
        '~' +
        hotspot.end +
        '；coverage=' +
        hotspot.coverageRatio +
        '，平均通道差=' +
        hotspot.averageChannelDelta +
        '，低于默认 diff 阈值=' +
        threshold +
        '。若这里本应是整行 divider / hairline，主 diff 很容易漏掉位置偏移。',
    })),
    ...horizontalBands.slice(0, 3).map((band, index) => ({
      kind: 'y-band',
      priority: 100 + index,
      summary:
        '纵向高差带 #' +
        (index + 1) +
        ' 位于 y=' +
        band.start +
        '~' +
        band.end +
        '；band diffRatio=' +
        band.diffRatio +
        '，平均通道差=' +
        band.averageChannelDelta +
        '。',
    })),
    ...verticalBands.slice(0, 3).map((band, index) => ({
      kind: 'x-band',
      priority: 200 + index,
      summary:
        '横向高差带 #' +
        (index + 1) +
        ' 位于 x=' +
        band.start +
        '~' +
        band.end +
        '；band diffRatio=' +
        band.diffRatio +
        '，平均通道差=' +
        band.averageChannelDelta +
        '。',
    })),
    ...gridHotspots.slice(0, 4).map((cell, index) => ({
      kind: 'grid-hotspot',
      priority: 300 + index,
      summary:
        '网格热区 #' +
        (index + 1) +
        ' 位于 row=' +
        cell.row +
        ', column=' +
        cell.column +
        '，box=' +
        formatBox(cell) +
        '；cell diffRatio=' +
        cell.diffRatio +
        '。',
    })),
  ]

  window.__DIFF_RESULT__ = {
    diffDataUrl: diffCanvas.toDataURL('image/png'),
    report: {
      agentHints,
      averageChannelDelta:
        diffPixels === 0 ? 0 : toFixedNumber(totalDelta / diffPixels / 4, 4),
      boundingBox:
        diffPixels === 0
          ? null
          : {
              height: maxY - minY + 1,
              width: maxX - minX + 1,
              x: minX,
              y: minY,
            },
      clusters: topClusters,
      diffPixels,
      diffRatio: toFixedNumber(diffPixels / totalPixels),
      gridHotspots: gridHotspots.slice(0, maxGridHotspots),
      hairlineHotspots: hairlineHotspots.slice(0, 8),
      height,
      horizontalBands,
      maxChannelDelta,
      regionStats,
      threshold,
      totalPixels,
      verticalBands,
      width,
    },
  }

  window.__RENDER_READY__ = true
})
`

export { DIFF_BROWSER_REPORT_RUNTIME }
