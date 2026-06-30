const formatPx = (value: number) => `${Math.round(value)}px`

const sanitizeId = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export { formatPx, sanitizeId }
