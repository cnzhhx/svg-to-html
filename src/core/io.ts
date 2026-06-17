const safeDecodeUri = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export { safeDecodeUri }
