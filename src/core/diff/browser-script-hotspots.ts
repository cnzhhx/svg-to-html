const DIFF_BROWSER_HOTSPOTS_RUNTIME = String.raw`
  diffContext.putImageData(diffImage, 0, 0)
  const hairlineHotspots = []

  // Track long low-delta rows separately; anti-aliased dividers can stay
  // below the main threshold while still marking a visible alignment miss.
  for (let row = 0; row < height; ) {
    const coverageRatio = hairlineRowCounts[row] / Math.max(1, width)
    if (coverageRatio < hairlineMinCoverage) {
      row += 1
      continue
    }

    let end = row
    let diffPixels = hairlineRowCounts[row]
    let deltaSum = hairlineRowDeltaSums[row]

    while (end + 1 < height) {
      const nextCoverageRatio = hairlineRowCounts[end + 1] / Math.max(1, width)
      if (nextCoverageRatio < hairlineMinCoverage) break
      if (end + 1 - row + 1 > hairlineMaxThickness) break
      end += 1
      diffPixels += hairlineRowCounts[end]
      deltaSum += hairlineRowDeltaSums[end]
    }

    hairlineHotspots.push({
      averageChannelDelta:
        diffPixels === 0 ? 0 : toFixedNumber(deltaSum / diffPixels / 4, 4),
      coverageRatio: toFixedNumber(
        diffPixels / Math.max(1, width * (end - row + 1)),
        4,
      ),
      end,
      height: end - row + 1,
      start: row,
    })
    row = end + 1
  }

  hairlineHotspots.sort((left, right) => {
    if (right.coverageRatio !== left.coverageRatio)
      return right.coverageRatio - left.coverageRatio
    return right.averageChannelDelta - left.averageChannelDelta
  })

  const horizontalBands = buildBands({
    axis: 'y',
    bandCount: horizontalBandCount,
    crossSpan: width,
    deltaSums: rowDeltaSums,
    diffCounts: rowDiffCounts,
    totalLength: height,
  })
  const verticalBands = buildBands({
    axis: 'x',
    bandCount: verticalBandCount,
    crossSpan: height,
    deltaSums: columnDeltaSums,
    diffCounts: columnDiffCounts,
    totalLength: width,
  })

  const gridHotspots = []

  for (let row = 0; row < gridRows; row += 1) {
    for (let column = 0; column < gridColumns; column += 1) {
      const cellIndex = row * gridColumns + column
      const startX = Math.floor((column * width) / gridColumns)
      const endX = Math.floor(((column + 1) * width) / gridColumns)
      const startY = Math.floor((row * height) / gridRows)
      const endY = Math.floor(((row + 1) * height) / gridRows)
      const cellWidth = Math.max(1, endX - startX)
      const cellHeight = Math.max(1, endY - startY)
      const cellPixels = cellWidth * cellHeight
      const cellDiffPixels = gridDiffCounts[cellIndex]
      if (!cellDiffPixels) continue

      gridHotspots.push({
        averageChannelDelta: toFixedNumber(
          gridDeltaSums[cellIndex] / cellDiffPixels / 4,
          4,
        ),
        column,
        diffPixels: cellDiffPixels,
        diffRatio: toFixedNumber(cellDiffPixels / cellPixels),
        height: cellHeight,
        row,
        width: cellWidth,
        x: startX,
        y: startY,
      })
    }
  }

  gridHotspots.sort((left, right) => {
    if (right.diffRatio !== left.diffRatio) return right.diffRatio - left.diffRatio
    return right.diffPixels - left.diffPixels
  })

  const visited = new Uint8Array(totalPixels)
  const clusters = []
  const directions = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    if (!diffMask[pixelIndex] || visited[pixelIndex]) continue

    const queue = [pixelIndex]
    visited[pixelIndex] = 1
    let head = 0
    let clusterDiffPixels = 0
    let clusterDeltaSum = 0
    let clusterMaxChannelDelta = 0
    let clusterMinX = width
    let clusterMinY = height
    let clusterMaxX = -1
    let clusterMaxY = -1
    let weightedX = 0
    let weightedY = 0
    let htmlLighterPixels = 0
    let htmlDarkerPixels = 0
    let htmlMoreOpaquePixels = 0
    let htmlLessOpaquePixels = 0

    while (head < queue.length) {
      const current = queue[head]
      head += 1

      const x = current % width
      const y = Math.floor(current / width)
      const channelDelta = maxChannelDeltaMap[current]
      const totalChannelDelta = totalDeltaMap[current]
      const signedLuma = signedLumaMap[current]
      const signedAlpha = signedAlphaMap[current]

      clusterDiffPixels += 1
      clusterDeltaSum += totalChannelDelta
      clusterMaxChannelDelta = Math.max(clusterMaxChannelDelta, channelDelta)
      clusterMinX = Math.min(clusterMinX, x)
      clusterMinY = Math.min(clusterMinY, y)
      clusterMaxX = Math.max(clusterMaxX, x)
      clusterMaxY = Math.max(clusterMaxY, y)
      weightedX += x
      weightedY += y

      if (signedLuma > 0) htmlLighterPixels += 1
      else if (signedLuma < 0) htmlDarkerPixels += 1

      if (signedAlpha > 0) htmlMoreOpaquePixels += 1
      else if (signedAlpha < 0) htmlLessOpaquePixels += 1

      for (const direction of directions) {
        const next = current + direction
        if (next < 0 || next >= totalPixels || visited[next] || !diffMask[next])
          continue

        const nextX = next % width
        const nextY = Math.floor(next / width)
        // Linear indices wrap at row edges, so guard coordinates before
        // accepting diagonal/side neighbors into the same cluster.
        if (Math.abs(nextX - x) > 1 || Math.abs(nextY - y) > 1) continue

        visited[next] = 1
        queue.push(next)
      }
    }

    const boundingBox = {
      height: clusterMaxY - clusterMinY + 1,
      width: clusterMaxX - clusterMinX + 1,
      x: clusterMinX,
      y: clusterMinY,
    }
    const clusterPixels = Math.max(1, boundingBox.width * boundingBox.height)

    clusters.push({
      averageChannelDelta: toFixedNumber(clusterDeltaSum / clusterDiffPixels / 4, 4),
      boundingBox,
      centroid: {
        x: toFixedNumber(weightedX / clusterDiffPixels, 2),
        y: toFixedNumber(weightedY / clusterDiffPixels, 2),
      },
      diffPixels: clusterDiffPixels,
      diffRatioWithinBounds: toFixedNumber(clusterDiffPixels / clusterPixels),
      dominantAlphaTrend: resolveTrend(
        htmlMoreOpaquePixels,
        htmlLessOpaquePixels,
        'html_more_opaque',
        'html_less_opaque',
      ),
      dominantLumaTrend: resolveTrend(
        htmlLighterPixels,
        htmlDarkerPixels,
        'html_lighter',
        'html_darker',
      ),
      htmlDarkerPixels,
      htmlLighterPixels,
      htmlLessOpaquePixels,
      htmlMoreOpaquePixels,
      id: '',
      maxChannelDelta: clusterMaxChannelDelta,
    })
  }

  clusters.sort((left, right) => {
    if (right.diffPixels !== left.diffPixels) return right.diffPixels - left.diffPixels
    if (right.diffRatioWithinBounds !== left.diffRatioWithinBounds)
      return right.diffRatioWithinBounds - left.diffRatioWithinBounds
    return right.averageChannelDelta - left.averageChannelDelta
  })

  const topClusters = clusters.slice(0, maxClusterCount).map((cluster, index) => ({
    ...cluster,
    id: 'cluster-' + (index + 1),
  }))

  const regionStats = regions.map((region) => {
    let regionDiffPixels = 0
    let regionMaxChannelDelta = 0
    let minRegionX = width
    let minRegionY = height
    let maxRegionX = -1
    let maxRegionY = -1

    const startX = Math.max(0, Math.floor(region.x))
    const startY = Math.max(0, Math.floor(region.y))
    const endX = Math.min(width, Math.ceil(region.x + region.width))
    const endY = Math.min(height, Math.ceil(region.y + region.height))
    const regionPixels = Math.max(1, (endX - startX) * (endY - startY))

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * width + x) * 4
        const alpha = diffImage.data[offset + 3]
        if (!alpha) continue
        regionDiffPixels += 1
        minRegionX = Math.min(minRegionX, x)
        minRegionY = Math.min(minRegionY, y)
        maxRegionX = Math.max(maxRegionX, x)
        maxRegionY = Math.max(maxRegionY, y)
        const regionDelta = Math.max(
          Math.abs(sourceImage.data[offset] - targetImage.data[offset]),
          Math.abs(sourceImage.data[offset + 1] - targetImage.data[offset + 1]),
          Math.abs(sourceImage.data[offset + 2] - targetImage.data[offset + 2]),
          Math.abs(sourceImage.data[offset + 3] - targetImage.data[offset + 3]),
        )
        regionMaxChannelDelta = Math.max(regionMaxChannelDelta, regionDelta)
      }
    }

    return {
      boundingBox:
        regionDiffPixels === 0
          ? null
          : {
              height: maxRegionY - minRegionY + 1,
              width: maxRegionX - minRegionX + 1,
              x: minRegionX,
              y: minRegionY,
            },
      diffPixels: regionDiffPixels,
      diffRatio: toFixedNumber(regionDiffPixels / regionPixels),
      id: region.id || 'region',
      maxChannelDelta: regionMaxChannelDelta,
    }
  })
`;

export { DIFF_BROWSER_HOTSPOTS_RUNTIME };
