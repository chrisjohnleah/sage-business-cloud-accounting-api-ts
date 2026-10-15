import createClient, { type Client, type FetchOptions } from 'openapi-fetch'
import { TokenManager } from './auth.js'
import { SageAuthError, SageNotConnectedError, SagePaginationError } from './errors.js'
import type { components, paths } from './generated/sage.js'
import { apiErrorFrom, createSageFetch } from './http.js'
import { authorizationUrl as buildAuthorizationUrl, requestToken, revokeToken, type Fetcher, type OAuthClient } from './oauth.js'
import { resolveNext } from './paginate.js'
import type { StoredToken, TokenStore } from './token-store.js'
import { randomBase64Url, safeEqual } from './util.js'
import { VERSION } from './version.js'

export const DEFAULT_BASE_URL = 'https://api.accounting.sage.com/v3.1'

export interface SageOptions {
  clientId: string
  clientSecret: string
  /** Must match the callback URL registered with your Sage app exactly. */
  redirectUri: string
  /** `readonly` (the default) or `full_access`. */
  scope?: 'readonly' | 'full_access'
  /** Sage's country picker shortcut: `gb` (the default), `ie` or `ca`. */
  country?: string
  tokenStore: TokenStore
  /** Replaces the global `fetch`. Takes a `Request`. Used by tests and by runtimes with their own fetch. */
  fetch?: Fetcher
  baseUrl?: string
  /** Refresh when the access token has less than this many seconds left. Default 60. */
  refreshBufferSeconds?: number
  /** How many times to repeat a call that Sage throttled or that failed in a way that is safe to repeat. Default 3. */
  retries?: number
  /** Per attempt, in milliseconds. Default 30000. */
  timeoutMs?: number
  /** Longest wait between attempts. A longer `Retry-After` returns the 429 instead. Default 60000. */
  maxRetryDelayMs?: number
  userAgent?: string
}

type GetPath = keyof { [P in keyof paths as paths[P] extends { get: unknown } ? P : never]: true }

type GetInit<P extends GetPath> = paths[P] extends { get: infer Operation } ? FetchOptions<Operation> : never

type PageOf<P extends GetPath> = paths[P] extends { get: { responses: { 200: { content: { 'application/json': infer Body } } } } } ? Body : never

/** The type of one entry of a list endpoint's `$items` (`unknown` where Sage's spec has no schema). */
export type ItemOf<P extends GetPath> = PageOf<P> extends { $items: readonly (infer Item)[] } ? Item : unknown

export type SageBusiness = components['schemas']['Business']

export interface Sage {
  /** openapi-fetch's client over Sage's spec: `{ data, error, response }`. Authorisation, retries and `X-Business` are handled for you. */
  readonly api: Client<paths>
  /** Where to send a person to connect. Keep `state` (cookie, session, database) and pass it to `handleCallback`. */
  authorizationUrl(options?: { state?: string }): { url: string; state: string }
  /** Checks the callback, trades its code for tokens and stores them. */
  handleCallback(callbackUrl: string | URL, expectedState: string): Promise<void>
  /** Every business the connected person can reach. */
  listBusinesses(): Promise<SageBusiness[]>
  /** Sends `X-Business: id` on every call from now on, and remembers it in the token store. */
  selectBusiness(businessId: string): Promise<void>
  /** Walks a list endpoint page by page, following `$next`. */
  paginate<P extends GetPath>(path: P, init?: GetInit<P>): AsyncGenerator<ItemOf<P>, void, undefined>
  /** Forgets the stored token. With `revoke`, asks Sage to stop honouring the refresh token first. */
  disconnect(options?: { revoke?: boolean }): Promise<void>
}

/** Returns `data`, or throws `SageApiError` when Sage answered with an error. */
export function assertOk<T extends { response: Response }>(result: T): T extends { data: infer D } ? D : never {
  const { response } = result
  const error = (result as { error?: unknown }).error
  if (!response.ok || error !== undefined) throw apiErrorFrom(response, error)
  return (result as { data?: unknown }).data as T extends { data: infer D } ? D : never
}

export function createSage(options: SageOptions): Sage {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? 30_000
  const userAgent = options.userAgent ?? `sage-business-cloud-accounting-api-ts/${VERSION}`
  const store = options.tokenStore
  const rawFetch: Fetcher = options.fetch ?? ((request) => globalThis.fetch(request))

  const oauth: OAuthClient = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    fetch: rawFetch,
    timeoutMs,
    userAgent,
  }
  const tokens = new TokenManager(oauth, store, (options.refreshBufferSeconds ?? 60) * 1000)
  const sageFetch = createSageFetch({
    fetch: rawFetch,
    tokens,
    baseUrl,
    retries: options.retries ?? 3,
    timeoutMs,
    maxRetryDelayMs: options.maxRetryDelayMs ?? 60_000,
    userAgent,
  })
  const api = createClient<paths>({ baseUrl, fetch: sageFetch })

  /** Read, change, write; try again if another process changed the token in between. */
  async function updateToken(change: (current: StoredToken) => StoredToken): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const current = await store.get()
      if (!current) throw new SageNotConnectedError('No Sage connection is stored. Send a person through authorizationUrl() first.')
      if ((await store.put(change(current), current)) !== false) return
    }
    throw new SageNotConnectedError('The stored token kept changing underneath this call. Try again.')
  }

  async function* paginate<P extends GetPath>(path: P, init?: GetInit<P>): AsyncGenerator<ItemOf<P>, void, undefined> {
    const seen = new Set<string>()
    let page = assertOk(await (api.GET as (path: string, init?: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>)(path, init)) as {
      $items?: ItemOf<P>[]
      $next?: string | null
    } | undefined
    for (;;) {
      yield* page?.$items ?? []
      const next = page?.$next
      if (!next) return
      const url = resolveNext(next, baseUrl)
      if (seen.has(url.href)) throw new SagePaginationError(`Sage's $next led back to a page already read: ${url.pathname}`)
      seen.add(url.href)
      const response = await sageFetch(new Request(url, { method: 'GET', signal: (init as { signal?: AbortSignal } | undefined)?.signal ?? null }))
      const text = await response.text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // keep the text for the error
      }
      if (!response.ok) throw apiErrorFrom(response, body)
      page = body as typeof page
    }
  }

  async function listBusinesses() {
    const businesses: SageBusiness[] = []
    for await (const business of paginate('/businesses')) businesses.push(business)
    return businesses
  }

  const selectBusiness = (businessId: string) => updateToken((current) => ({ ...current, businessId }))

  return {
    api,

    authorizationUrl({ state = randomBase64Url(32) } = {}) {
      const url = buildAuthorizationUrl(oauth, { scope: options.scope ?? 'readonly', country: options.country ?? 'gb', state })
      return { url, state }
    },

    async handleCallback(callbackUrl, expectedState) {
      const params = new URL(callbackUrl).searchParams
      const state = params.get('state')
      if (!expectedState || !state || !safeEqual(state, expectedState)) {
        throw new SageAuthError('state_mismatch', 'The state in the callback is missing or is not the one this connection attempt started with.')
      }
      const error = params.get('error')
      if (error) throw new SageAuthError(error, params.get('error_description'))
      const code = params.get('code')
      if (!code) throw new SageAuthError('invalid_request', 'The callback has no code.')
      const response = await requestToken(oauth, { grant_type: 'authorization_code', code, redirect_uri: options.redirectUri })
      // Save the new connection, trying again if another process changes the stored token underneath us.
      let remembered: string | null = null
      for (let i = 0; ; i++) {
        const previous = await store.get()
        remembered ??= previous?.businessId ?? null
        if ((await store.put({ ...response, businessId: null }, previous)) !== false) break
        if (i === 2) throw new SageNotConnectedError('The new connection could not be saved because the stored token kept changing. Try connecting again.')
      }
      // Reconnecting keeps the chosen business only when this Sage login can reach it (it may be a different login).
      if (remembered && (await listBusinesses()).some((business) => business.id === remembered)) await selectBusiness(remembered)
    },

    listBusinesses,

    selectBusiness,

    paginate,

    async disconnect({ revoke = false } = {}) {
      try {
        const current = revoke ? await store.get() : null
        if (current) await revokeToken(oauth, current.refreshToken)
      } finally {
        await store.forget()
      }
    },
  }
}
