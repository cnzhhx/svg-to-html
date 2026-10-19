export const basePath = '/transformer'

export class ApiError extends Error {
  payload: Record<string, unknown>
  status: number

  constructor(message: string, status: number, payload: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.payload = payload
    this.status = status
  }
}

const readError = async (response: Response) => {
  try {
    const parsed = (await response.json()) as Record<string, unknown>
    return {
      message: String(parsed.error || response.statusText || 'Request failed'),
      payload: parsed,
    }
  } catch {
    return {
      message: response.statusText || 'Request failed',
      payload: {},
    }
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${basePath}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'X-Requested-With': 'svg-to-html',
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const error = await readError(response)
    throw new ApiError(error.message, response.status, error.payload)
  }
  return (await response.json()) as T
}

export const apiUrl = (path: string) => `${basePath}${path}`
