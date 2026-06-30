const DIFF_BROWSER_REPORT_RUNTIME = String.raw`
  diffContext.putImageData(diffImage, 0, 0)

  window.__DIFF_RESULT__ = {
    diffDataUrl: diffCanvas.toDataURL('image/png'),
    report: {
      diffPixels,
      diffRatio: toFixedNumber(diffPixels / totalPixels),
      totalPixels,
      width,
      height,
    },
  }

  window.__RENDER_READY__ = true
})
`

export { DIFF_BROWSER_REPORT_RUNTIME }
