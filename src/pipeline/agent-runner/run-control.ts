const createAbortError = (reason: unknown = 'aborted') => {
  const error = new Error(typeof reason === 'string' ? reason : 'aborted')
  error.name = 'AbortError'
  return error
}

const throwIfRunAborted = (controller: AbortController) => {
  if (!controller.signal.aborted) return
  throw createAbortError(controller.signal.reason)
}

const isAbortError = (error: unknown) => {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'AbortError' ||
    error.message.includes('aborted') ||
    error.message.includes('AbortError')
  )
}

export { isAbortError, throwIfRunAborted }
