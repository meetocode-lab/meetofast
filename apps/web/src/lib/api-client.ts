let currentCsrfToken = ''

export function setActiveCsrfToken(token: string): void {
  currentCsrfToken = token
}

export function getActiveCsrfToken(): string {
  return currentCsrfToken
}

export class ApiClientError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { csrfToken?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const token = options.csrfToken ?? currentCsrfToken
  if (token && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', token)
  }

  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers,
  })

  const isJson = response.headers.get('content-type')?.includes('json')
  const payload = isJson ? ((await response.json()) as Record<string, unknown>) : null

  if (!response.ok) {
    const errObj = (payload?.error ?? {}) as {
      code?: string
      message?: string
      details?: unknown
    }
    throw new ApiClientError(
      response.status,
      errObj.code ?? 'REQUEST_FAILED',
      errObj.message ?? `Request failed with status ${response.status}`,
      errObj.details ?? payload,
    )
  }

  return payload as T
}
