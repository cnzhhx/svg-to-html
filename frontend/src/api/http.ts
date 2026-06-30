export const basePath = '/transformer'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const readErrorMessage = async (response: Response) => {
  try {
    const parsed = (await response.json()) as { error?: unknown }
    return String(parsed.error || response.statusText || 'Request failed')
  } catch {
    return response.statusText || 'Request failed'
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${basePath}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  return (await response.json()) as T
}

export const apiUrl = (path: string) => `${basePath}${path}`
