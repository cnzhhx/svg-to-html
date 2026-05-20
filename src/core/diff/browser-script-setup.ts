const DIFF_BROWSER_SETUP_RUNTIME = String.raw`
const loadImage = (url) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = url
})

const toFixedNumber = (value, digits = 6) => Number(value.toFixed(digits))
const resolveTrend = (positive, negative, positiveLabel, negativeLabel) => {
  if (!positive && !negative) return 'mixed'
  if (positive > negative * 1.15) return positiveLabel
  if (negative > positive * 1.15) return negativeLabel
  return 'mixed'
}

const formatBox = (box) =>
  'x=' + box.x + ', y=' + box.y + ', w=' + box.width + ', h=' + box.height

const describeLumaTrend = (trend) => {
  if (trend === 'html_lighter') return 'HTML 整体更亮'
  if (trend === 'html_darker') return 'HTML 整体更暗'
  return '明暗趋势混合'
}

const describeAlphaTrend = (trend) => {
  if (trend === 'html_more_opaque') return 'HTML 整体更实'
  if (trend === 'html_less_opaque') return 'HTML 整体更虚'
  return '透明度趋势混合'
}

const buildBands = ({
  axis,
  bandCount,
  crossSpan,
  deltaSums,
  diffCounts,
  totalLength,
}) => {
  const step = Math.max(1, Math.ceil(totalLength / bandCount))
  const bands = []

  for (let start = 0, index = 0; start < totalLength; start += step, index += 1) {
    const end = Math.min(totalLength, start + step)
    let diffPixels = 0
    let deltaSum = 0

    for (let offset = start; offset < end; offset += 1) {
      diffPixels += diffCounts[offset]
      deltaSum += deltaSums[offset]
    }

    const bandPixels = Math.max(1, (end - start) * crossSpan)
    bands.push({
      averageChannelDelta:
        diffPixels === 0 ? 0 : toFixedNumber(deltaSum / diffPixels / 4, 4),
      axis,
      diffPixels,
      diffRatio: toFixedNumber(diffPixels / bandPixels),
      end: end - 1,
      id: axis + '-band-' + (index + 1),
      start,
    })
  }

  return bands
    .filter((band) => band.diffPixels > 0)
    .sort((left, right) => {
      if (right.diffRatio !== left.diffRatio) return right.diffRatio - left.diffRatio
      return right.diffPixels - left.diffPixels
    })
    .slice(0, maxBandCount)
}

Promise.all([loadImage(svgUrl), loadImage(htmlUrl)]).then(([svgImage, htmlImage]) => {
  const width = svgImage.width
  const height = svgImage.height
  const totalPixels = width * height
  const sourceCanvas = document.createElement('canvas')
  const targetCanvas = document.createElement('canvas')
  const diffCanvas = document.getElementById('diff')

  sourceCanvas.width = width
  sourceCanvas.height = height
  targetCanvas.width = width
  targetCanvas.height = height
  diffCanvas.width = width
  diffCanvas.height = height

  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
  const targetContext = targetCanvas.getContext('2d', { willReadFrequently: true })
  const diffContext = diffCanvas.getContext('2d')

  sourceContext.drawImage(svgImage, 0, 0)
  targetContext.drawImage(htmlImage, 0, 0)

  const sourceImage = sourceContext.getImageData(0, 0, width, height)
  const targetImage = targetContext.getImageData(0, 0, width, height)
  const diffImage = diffContext.createImageData(width, height)

  let diffPixels = 0
  let totalDelta = 0
  let maxChannelDelta = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const diffMask = new Uint8Array(totalPixels)
  const maxChannelDeltaMap = new Uint8Array(totalPixels)
  const totalDeltaMap = new Uint16Array(totalPixels)
  const signedLumaMap = new Float32Array(totalPixels)
  const signedAlphaMap = new Int16Array(totalPixels)
  const rowDiffCounts = new Uint32Array(height)
  const rowDeltaSums = new Float64Array(height)
  const columnDiffCounts = new Uint32Array(width)
  const columnDeltaSums = new Float64Array(width)
  const hairlineRowCounts = new Uint32Array(height)
  const hairlineRowDeltaSums = new Float64Array(height)
  const gridDiffCounts = new Uint32Array(gridColumns * gridRows)
  const gridDeltaSums = new Float64Array(gridColumns * gridRows)

  for (let index = 0; index < sourceImage.data.length; index += 4) {
    const pixelIndex = index / 4
    const x = pixelIndex % width
    const y = Math.floor(pixelIndex / width)

    const deltaR = Math.abs(sourceImage.data[index] - targetImage.data[index])
    const deltaG = Math.abs(sourceImage.data[index + 1] - targetImage.data[index + 1])
    const deltaB = Math.abs(sourceImage.data[index + 2] - targetImage.data[index + 2])
    const deltaA = Math.abs(sourceImage.data[index + 3] - targetImage.data[index + 3])
    const channelDelta = Math.max(deltaR, deltaG, deltaB, deltaA)
    const totalChannelDelta = deltaR + deltaG + deltaB + deltaA
    const sourceLuma =
      sourceImage.data[index] * 0.2126 +
      sourceImage.data[index + 1] * 0.7152 +
      sourceImage.data[index + 2] * 0.0722
    const targetLuma =
      targetImage.data[index] * 0.2126 +
      targetImage.data[index + 1] * 0.7152 +
      targetImage.data[index + 2] * 0.0722

    if (channelDelta > hairlineThreshold && channelDelta <= threshold) {
      hairlineRowCounts[y] += 1
      hairlineRowDeltaSums[y] += totalChannelDelta
    }

    if (channelDelta <= threshold) continue

    diffPixels += 1
    totalDelta += totalChannelDelta
    maxChannelDelta = Math.max(maxChannelDelta, channelDelta)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    diffMask[pixelIndex] = 1
    maxChannelDeltaMap[pixelIndex] = channelDelta
    totalDeltaMap[pixelIndex] = totalChannelDelta
    signedLumaMap[pixelIndex] = targetLuma - sourceLuma
    signedAlphaMap[pixelIndex] =
      targetImage.data[index + 3] - sourceImage.data[index + 3]
    rowDiffCounts[y] += 1
    rowDeltaSums[y] += totalChannelDelta
    columnDiffCounts[x] += 1
    columnDeltaSums[x] += totalChannelDelta

    const gridColumn = Math.min(
      gridColumns - 1,
      Math.floor((x / Math.max(1, width)) * gridColumns),
    )
    const gridRow = Math.min(
      gridRows - 1,
      Math.floor((y / Math.max(1, height)) * gridRows),
    )
    const gridIndex = gridRow * gridColumns + gridColumn
    gridDiffCounts[gridIndex] += 1
    gridDeltaSums[gridIndex] += totalChannelDelta

    diffImage.data[index] = 255
    diffImage.data[index + 1] = Math.min(255, totalChannelDelta)
    diffImage.data[index + 2] = 0
    diffImage.data[index + 3] = 255
  }
`

export { DIFF_BROWSER_SETUP_RUNTIME }
