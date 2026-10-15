import type { TokenManager } from './auth.js'
import { SageApiError } from './errors.js'
import type { Fetcher } from './oauth.js'
import { anySignal, sleep } from './util.js'

export interface HttpOptions {
  fetch: Fetcher
  tokens: TokenManager
  baseUrl: string
  retries: number
  timeoutMs: number
  maxRetryDelayMs: number
  userAgent: string
}

const SAFE_TO_REPEAT = new Set(['GET', 'HEAD', 'PUT', 'DELETE'])

/** What was asked, kept beside each response so `assertOk` can say which call failed. */
const requests = new WeakMap<Response, { method: string; path: string }>()

export function describeRequest(response: Response): { method: string; path: string } {
  return requests.get(response) ?? { method: 'GET', path: new URL(response.url || 'http://unknown/').pathname }
}

export function apiErrorFrom(response: Response, body: unknown): SageApiError {
  return new SageApiError({
    status: response.status,
    body,
    ...describeRequest(response),
    requestId: response.headers.get('x_request_id') ?? response.headers.get('x-request-id'),
  })
}

/** Seconds or an HTTP date, as milliseconds to wait. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

const backoffMs = (retry: number) => 1000 * 2 ** retry * (0.5 + Math.random() / 2)

/**
 * The fetch that openapi-fetch calls. It adds the headers, refreshes the token,
 * and repeats requests that are safe to repeat. See the README for the rules.
 */
export function createSageFetch(options: HttpOptions): Fetcher {
  const basePath = new URL(options.baseUrl).pathname.replace(/\/$/, '')

  return async (request) => {
    const method = request.method.toUpperCase()
    const callerSignal = request.signal
    const bodyText = method === 'GET' || method === 'HEAD' ? undefined : await request.clone().text()
    const mayRepeat = SAFE_TO_REPEAT.has(method)
    const url = new URL(request.url)
    const info = { method, path: url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : url.pathname }

    const attempt = async (accessToken: string, businessId: string | null) => {
      const headers = new Headers(request.headers)
      headers.set('Authorization', `Bearer ${accessToken}`)
      if (!headers.has('Accept')) headers.set('Accept', 'application/json')
      if (bodyText !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
      headers.set('User-Agent', options.userAgent)
      if (businessId) headers.set('X-Business', businessId)
      const response = await options.fetch(
        new Request(request.url, {
          method,
          headers,
          body: bodyText,
          redirect: request.redirect,
          signal: anySignal([AbortSignal.timeout(options.timeoutMs), callerSignal]),
        }),
      )
      requests.set(response, info)
      return response
    }

    const discard = (response: Response) => void response.body?.cancel().catch(() => {})

    let token = await options.tokens.get()
    let retries = 0
    let refreshedAfter401 = false
    for (;;) {
      let response: Response
      try {
        response = await attempt(token.accessToken, token.businessId)
      } catch (error) {
        // The caller gave up, or this is a network error or timeout.
        if (callerSignal.aborted || !mayRepeat || retries >= options.retries) throw error
        await sleep(backoffMs(retries++), callerSignal)
        continue
      }

      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true
        discard(response)
        token = await options.tokens.get(token.accessToken)
        continue
      }

      const retryable = response.status === 429 || (response.status >= 500 && mayRepeat)
      if (!retryable || retries >= options.retries) return response
      const wait = parseRetryAfter(response.headers.get('Retry-After')) ?? backoffMs(retries)
      // A wait longer than the cap (Sage can ask for hours) is not worth holding a request open for.
      if (wait > options.maxRetryDelayMs) return response
      discard(response)
      await sleep(wait, callerSignal)
      retries++
    }
  }
}
