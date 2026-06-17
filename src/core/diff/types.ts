type DiffReport = {
  diffPixels: number
  diffRatio: number
  height: number
  totalPixels: number
  width: number
}

type DiffPageResult = {
  diffDataUrl: string
  report: DiffReport
}

export type {
  DiffPageResult,
}
