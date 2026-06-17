const DIFF_BROWSER_SETUP_RUNTIME = String.raw`
const loadImage = (url) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = url
})

const toFixedNumber = (value, digits = 6) => Number(value.toFixed(digits))

Promise.all([loadImage(svgUrl), loadImage(renderUrl)]).then(([svgImage, renderImage]) => {
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

  sourceContext.filter = 'blur(0.5px)'
  sourceContext.drawImage(svgImage, 0, 0)
  targetContext.filter = 'blur(0.5px)'
  targetContext.drawImage(renderImage, 0, 0)

  const sourceImage = sourceContext.getImageData(0, 0, width, height)
  const targetImage = targetContext.getImageData(0, 0, width, height)
  const diffImage = diffContext.createImageData(width, height)

  const quantize = (value) => Math.floor(value / 4) * 4
  let diffPixels = 0

  for (let index = 0; index < sourceImage.data.length; index += 4) {
    const srcR = quantize(sourceImage.data[index])
    const srcG = quantize(sourceImage.data[index + 1])
    const srcB = quantize(sourceImage.data[index + 2])
    const srcA = quantize(sourceImage.data[index + 3])
    const tgtR = quantize(targetImage.data[index])
    const tgtG = quantize(targetImage.data[index + 1])
    const tgtB = quantize(targetImage.data[index + 2])
    const tgtA = quantize(targetImage.data[index + 3])

    const deltaR = Math.abs(srcR - tgtR)
    const deltaG = Math.abs(srcG - tgtG)
    const deltaB = Math.abs(srcB - tgtB)
    const deltaA = Math.abs(srcA - tgtA)
    const channelDelta = Math.max(deltaR, deltaG, deltaB, deltaA)
    const totalChannelDelta = deltaR + deltaG + deltaB + deltaA

    if (channelDelta <= threshold) continue

    diffPixels += 1

    diffImage.data[index] = 255
    diffImage.data[index + 1] = Math.min(255, totalChannelDelta)
    diffImage.data[index + 2] = 0
    diffImage.data[index + 3] = 255
  }
`

export { DIFF_BROWSER_SETUP_RUNTIME }
