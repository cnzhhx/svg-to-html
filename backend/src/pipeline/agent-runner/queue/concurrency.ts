const throwIfAbortedSignal = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'aborted',
  )
  error.name = 'AbortError'
  throw error
}

/**
 * A shared concurrency limiter. Multiple callers across different async flows
 * can call `run()` concurrently; at most `limit` functions execute simultaneously.
 */
class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
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

export { runWithLimit, Semaphore }
