import { createSage, MemoryTokenStore, type SageOptions, type StoredToken } from '../../src/index.js'

export interface Recorded {
  method: string
  url: string
  headers: Headers
  body: string
  signal: AbortSignal
}

type Reply = Response | Error | ((request: Recorded) => Response | Error | Promise<Response | Error>)

/**
 * A fetch that records every request and answers from a script. Nothing here
 * can reach the network: a request with no scripted reply throws.
 * Keys look like `POST /token` and match anywhere in `METHOD url`.
 */
export function fakeFetch() {
  const calls: Recorded[] = []
  const queues = new Map<string, Reply[]>()

  const fetch = async (request: Request): Promise<Response> => {
    if (request.signal.aborted) throw request.signal.reason
    const recorded: Recorded = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: new TextDecoder().decode(await request.arrayBuffer()),
      signal: request.signal,
    }
    calls.push(recorded)
    const line = `${recorded.method} ${recorded.url}`
    for (const [key, queue] of queues) {
      if (!line.includes(key) || queue.length === 0) continue
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!
      const result = typeof reply === 'function' ? await reply(recorded) : reply
      if (result instanceof Error) throw result
      return result.clone()
    }
    throw new Error(`fake fetch: no scripted reply for ${line}`)
  }

  return {
    fetch,
    calls,
    /** Replies are used in order; the last one repeats. */
    on(key: string, ...replies: Reply[]) {
      queues.set(key, replies)
      return this
    },
    to(key: string) {
      return calls.filter((c) => `${c.method} ${c.url}`.includes(key))
    },
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

export const tokenReply = (access: string, refresh: string, expiresIn = 300) =>
  json({ access_token: access, refresh_token: refresh, expires_in: expiresIn, token_type: 'bearer', scope: 'full_access' })

export const BASE = 'https://api.accounting.sage.com/v3.1'

export const storedToken = (over: Partial<StoredToken> = {}): StoredToken => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 5 * 60_000,
  businessId: null,
  ...over,
})

/** A client wired to a fake fetch and a memory store that already holds a token. */
export function setup(options: Partial<SageOptions> = {}, token: StoredToken | null = storedToken()) {
  const fake = fakeFetch()
  const store = options.tokenStore ?? new MemoryTokenStore(token)
  const sage = createSage({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.test/callback',
    tokenStore: store,
    fetch: fake.fetch,
    ...options,
  })
  return { fake, store, sage }
}
