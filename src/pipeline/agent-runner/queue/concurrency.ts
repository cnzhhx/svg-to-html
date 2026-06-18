const throwIfAbortedSignal = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'aborted',
  )
  error.name = 'AbortError'
  throw error
}

const runWithLimit = async <T, R>({
  items,
  limit,
  signal,
  worker,
}: {
  items: T[]
  limit: number
  signal?: AbortSignal
  worker: (item: T, index: number) => Promise<R>
}) => {
  const results: R[] = []
  let cursor = 0

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        throwIfAbortedSignal(signal)
        const index = cursor
        cursor += 1
        results[index] = await worker(items[index]!, index)
      }
    },
  )

  await Promise.all(workers)
  return results
}

export { runWithLimit }
