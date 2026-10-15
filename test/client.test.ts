import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertOk, MemoryTokenStore, SageApiError, SageNotConnectedError, type StoredToken, type TokenStore } from '../src/index.js'
import { VERSION } from '../src/version.js'
import { BASE, json, setup, storedToken, tokenReply } from './helpers/fake-fetch.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const TOKEN = 'POST https://oauth.accounting.sage.com/token'
const ok = () => json({ $items: [], $next: null })

describe('requests', () => {
  it('sends the bearer token and the standard headers', async () => {
    const { sage, fake } = setup()
    fake.on('GET', ok())
    await sage.api.GET('/contacts', { params: { query: { search: 'Acme' } } })
    const [call] = fake.calls
    expect(call!.url).toBe(`${BASE}/contacts?search=Acme`)
    expect(call!.headers.get('Authorization')).toBe('Bearer access-1')
    expect(call!.headers.get('Accept')).toBe('application/json')
    expect(call!.headers.get('User-Agent')).toBe(`sage-business-cloud-accounting-api-ts/${VERSION}`)
    expect(call!.headers.has('Content-Type')).toBe(false)
    expect(call!.headers.has('X-Business')).toBe(false)
  })

  it('sends JSON bodies with a content type, and lets the base URL and agent be changed', async () => {
    const { sage, fake } = setup({ baseUrl: 'https://sandbox.test/v3.1/', userAgent: 'example-app/1' })
    fake.on('POST', json({ id: 'inv-1' }, 201))
    await sage.api.POST('/sales_invoices', {
      body: { sales_invoice: { contact_id: 'c1', date: '2026-10-14', invoice_lines: [{ description: 'Blinds', ledger_account_id: 'l1', unit_price: 120 }] } },
    })
    const [call] = fake.calls
    expect(call!.url).toBe('https://sandbox.test/v3.1/sales_invoices')
    expect(call!.headers.get('Content-Type')).toBe('application/json')
    expect(call!.headers.get('User-Agent')).toBe('example-app/1')
    expect(JSON.parse(call!.body).sales_invoice.contact_id).toBe('c1')
  })

  it('sends X-Business on API calls once a business is selected, and never on token calls', async () => {
    const { sage, fake, store } = setup({}, storedToken({ expiresAt: Date.now() + 1000 }))
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    fake.on('GET', ok())
    await sage.selectBusiness('biz-9')
    expect(await store.get()).toMatchObject({ businessId: 'biz-9' })

    await sage.api.GET('/contacts')
    expect(fake.to('/token')).toHaveLength(1)
    expect(fake.to('/token')[0]!.headers.has('X-Business')).toBe(false)
    expect(fake.to('/contacts')[0]!.headers.get('X-Business')).toBe('biz-9')
    // the business survives the refresh
    expect(await store.get()).toMatchObject({ refreshToken: 'refresh-2', businessId: 'biz-9' })
  })

  it('throws SageNotConnectedError before any request when nothing is stored', async () => {
    const { sage, fake } = setup({}, null)
    await expect(sage.api.GET('/contacts')).rejects.toBeInstanceOf(SageNotConnectedError)
    await expect(sage.selectBusiness('x')).rejects.toBeInstanceOf(SageNotConnectedError)
    expect(fake.calls).toHaveLength(0)
  })

  it('lists businesses across pages', async () => {
    const { sage, fake } = setup()
    fake.on('/businesses', json({ $items: [{ id: 'b1', displayed_as: 'One' }], $next: '/businesses?page=2' }), json({ $items: [{ id: 'b2' }], $next: null }))
    expect((await sage.listBusinesses()).map((b) => b.id)).toEqual(['b1', 'b2'])
  })
})

describe('refreshing the token', () => {
  it('refreshes when the token expires inside the buffer and stores the rotation', async () => {
    const { sage, fake, store } = setup({}, storedToken({ expiresAt: Date.now() + 30_000, businessId: 'biz-1' }))
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    fake.on('GET', ok())
    await sage.api.GET('/contacts')
    expect(Object.fromEntries(new URLSearchParams(fake.to('/token')[0]!.body))).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    })
    expect(fake.to('/contacts')[0]!.headers.get('Authorization')).toBe('Bearer access-2')
    expect(await store.get()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', businessId: 'biz-1' })
  })

  it('leaves a token alone when it has more than the buffer left, and honours refreshBufferSeconds', async () => {
    const one = setup({}, storedToken({ expiresAt: Date.now() + 90_000 }))
    one.fake.on('GET', ok())
    await one.sage.api.GET('/contacts')
    expect(one.fake.to('/token')).toHaveLength(0)

    const two = setup({ refreshBufferSeconds: 120 }, storedToken({ expiresAt: Date.now() + 90_000 }))
    two.fake.on(TOKEN, tokenReply('access-2', 'refresh-2')).on('GET', ok())
    await two.sage.api.GET('/contacts')
    expect(two.fake.to('/token')).toHaveLength(1)
  })

  it('makes one token request for concurrent calls', async () => {
    const { sage, fake } = setup({}, storedToken({ expiresAt: Date.now() - 1 }))
    fake.on(TOKEN, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return tokenReply('access-2', 'refresh-2')
    })
    fake.on('GET', ok())
    await Promise.all([sage.api.GET('/contacts'), sage.api.GET('/products'), sage.api.GET('/ledger_accounts')])
    expect(fake.to('/token')).toHaveLength(1)
    expect(fake.to('GET').map((c) => c.headers.get('Authorization'))).toEqual(Array(3).fill('Bearer access-2'))
  })

  it('uses the winner\'s token when the compare and swap is lost', async () => {
    const winner = storedToken({ accessToken: 'access-w', refreshToken: 'refresh-w', expiresAt: Date.now() + 250_000 })
    let current: StoredToken | null = storedToken({ expiresAt: Date.now() - 1 })
    const store: TokenStore = {
      get: () => current,
      put: () => {
        current = winner // another process stored its refresh between our read and our write
        return false
      },
      forget: () => {
        current = null
      },
    }
    const { sage, fake } = setup({ tokenStore: store })
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2')).on('GET', ok())
    await sage.api.GET('/contacts')
    expect(fake.to('/contacts')[0]!.headers.get('Authorization')).toBe('Bearer access-w')
    expect(current).toBe(winner)
  })

  it('keeps a business chosen while the refresh request is in flight', async () => {
    const { sage, fake, store } = setup({}, storedToken({ expiresAt: Date.now() - 1, businessId: 'biz-old' }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    fake.on(TOKEN, async () => {
      await gate
      return tokenReply('access-2', 'refresh-2')
    })
    fake.on('GET', ok())
    const call = sage.api.GET('/contacts')
    await vi.waitFor(() => expect(fake.to('/token')).toHaveLength(1))
    await sage.selectBusiness('biz-new') // while Sage has not answered yet
    release()
    await call
    expect(await store.get()).toMatchObject({ refreshToken: 'refresh-2', businessId: 'biz-new' })
    expect(fake.to('/contacts')[0]!.headers.get('X-Business')).toBe('biz-new')
  })

  it('does not send a refresh token that a finished refresh has already used, even when the store read was slow', async () => {
    const inner = new MemoryTokenStore(storedToken({ expiresAt: Date.now() - 1 }))
    let slowRead: (() => void) | null = null
    let reads = 0
    const store: TokenStore = {
      // The second read takes a snapshot straight away but only answers once told to, as a slow database would.
      get: () => {
        const snapshot = inner.get()
        if (++reads !== 2) return snapshot
        return new Promise((resolve) => (slowRead = () => resolve(snapshot)))
      },
      put: (next, previous) => inner.put(next, previous),
      forget: () => inner.forget(),
    }
    const { sage, fake } = setup({ tokenStore: store })
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    fake.on('GET', ok())
    const first = sage.api.GET('/contacts')
    const second = sage.api.GET('/products') // its store read is the slow one
    await first
    expect(fake.to('/token')).toHaveLength(1)
    slowRead!()
    await second
    expect(fake.to('/token')).toHaveLength(1)
    expect(fake.to('/products')[0]!.headers.get('Authorization')).toBe('Bearer access-2')
  })

  it('does not undo a disconnect that happens during a refresh', async () => {
    const { sage, fake, store } = setup({}, storedToken({ expiresAt: Date.now() - 1 }))
    fake.on(TOKEN, async () => {
      await sage.disconnect()
      return tokenReply('access-2', 'refresh-2')
    })
    await expect(sage.api.GET('/contacts')).rejects.toBeInstanceOf(SageNotConnectedError)
    expect(await store.get()).toBeNull()
    expect(fake.to('/contacts')).toHaveLength(0)
  })

  it('throws instead of returning a token it could not save', async () => {
    const stored = storedToken({ expiresAt: Date.now() - 1 })
    const store: TokenStore = { get: () => stored, put: () => false, forget: () => {} }
    const { sage, fake } = setup({ tokenStore: store })
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    await expect(sage.api.GET('/contacts')).rejects.toBeInstanceOf(SageNotConnectedError)
    expect(fake.to('/contacts')).toHaveLength(0)
  })

  it('recovers from invalid_grant when another process already stored a newer token', async () => {
    const store = new MemoryTokenStore(storedToken({ expiresAt: Date.now() - 1 }))
    const { sage, fake } = setup({ tokenStore: store })
    fake.on(TOKEN, async () => {
      store.put(storedToken({ accessToken: 'access-w', refreshToken: 'refresh-w' }), store.get())
      return json({ error: 'invalid_grant' }, 400)
    })
    fake.on('GET', ok())
    await sage.api.GET('/contacts')
    expect(fake.to('/contacts')[0]!.headers.get('Authorization')).toBe('Bearer access-w')
    expect(store.get()!.refreshToken).toBe('refresh-w')
  })

  it('throws SageNotConnectedError on invalid_grant with nothing newer, and keeps the stored token', async () => {
    const { sage, fake, store } = setup({}, storedToken({ expiresAt: Date.now() - 1 }))
    fake.on(TOKEN, json({ error: 'invalid_grant', error_description: 'revoked' }, 400))
    await expect(sage.api.GET('/contacts')).rejects.toBeInstanceOf(SageNotConnectedError)
    expect(fake.to('/contacts')).toHaveLength(0)
    expect(await store.get()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('surfaces other refusals from the token endpoint as SageAuthError', async () => {
    const { sage, fake } = setup({}, storedToken({ expiresAt: Date.now() - 1 }))
    fake.on(TOKEN, json({ error: 'invalid_client' }, 401))
    await expect(sage.api.GET('/contacts')).rejects.toMatchObject({ name: 'SageAuthError', code: 'invalid_client' })
  })
})

describe('a 401 from the API', () => {
  it('refreshes once and repeats the request once', async () => {
    const { sage, fake } = setup()
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    fake.on('GET', json([{ $dataCode: 'AccessTokenExpiredError' }], 401), ok())
    const result = await sage.api.GET('/contacts')
    expect(result.response.status).toBe(200)
    expect(fake.to('/token')).toHaveLength(1)
    expect(fake.to('/contacts').map((c) => c.headers.get('Authorization'))).toEqual(['Bearer access-1', 'Bearer access-2'])
  })

  it('does not loop: a second 401 comes back to the caller', async () => {
    const { sage, fake } = setup()
    fake.on(TOKEN, tokenReply('access-2', 'refresh-2'))
    fake.on('GET', json([{ $dataCode: 'Unauthorized', $message: 'nope' }], 401))
    const result = await sage.api.GET('/contacts')
    expect(result.response.status).toBe(401)
    expect(fake.to('/contacts')).toHaveLength(2)
    expect(fake.to('/token')).toHaveLength(1)
  })

  it('does not refresh again when another process already replaced the rejected token', async () => {
    const store = new MemoryTokenStore(storedToken())
    const { sage, fake } = setup({ tokenStore: store })
    fake.on('GET', () => {
      store.put(storedToken({ accessToken: 'access-w', refreshToken: 'refresh-w' }), store.get())
      return json([], 401)
    }, ok())
    await sage.api.GET('/contacts')
    expect(fake.to('/token')).toHaveLength(0)
    expect(fake.to('/contacts')[1]!.headers.get('Authorization')).toBe('Bearer access-w')
  })
})

describe('retries', () => {
  it('waits Retry-After seconds on a 429', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { sage, fake } = setup()
    fake.on('GET', json([], 429, { 'Retry-After': '2' }), ok())
    const pending = sage.api.GET('/contacts')
    await vi.advanceTimersByTimeAsync(1999)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).response.status).toBe(200)
    expect(fake.calls).toHaveLength(2)
  })

  it('waits until the Retry-After date on a 429', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'))
    const { sage, fake } = setup()
    fake.on('GET', json([], 429, { 'Retry-After': 'Wed, 14 Oct 2026 12:00:03 GMT' }), ok())
    const pending = sage.api.GET('/contacts')
    await vi.advanceTimersByTimeAsync(2999)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).response.status).toBe(200)
  })

  it('backs off exponentially with jitter when there is no Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(1) // top of the jitter range: 1s, then 2s
    const { sage, fake } = setup()
    fake.on('GET', json([], 429), json([], 429), ok())
    const pending = sage.api.GET('/contacts')
    await vi.advanceTimersByTimeAsync(999)
    expect(fake.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fake.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).response.status).toBe(200)
  })

  it('retries a 429 on POST too, and stops after `retries`', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { sage, fake } = setup({ retries: 2 })
    fake.on('POST', json([], 429, { 'Retry-After': '1' }))
    const pending = sage.api.POST('/contacts', { body: { contact: { name: 'A', contact_type_ids: ['CUSTOMER'] } } })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).response.status).toBe(429)
    expect(fake.calls).toHaveLength(3)
  })

  it('hands back the 429 straight away when Sage asks for a very long wait', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json([], 429, { 'Retry-After': '86400' }))
    const result = await sage.api.GET('/contacts')
    expect(result.response.status).toBe(429)
    expect(fake.calls).toHaveLength(1)
  })

  it.each(['GET', 'PUT', 'DELETE'] as const)('retries a 5xx on %s', async (method) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { sage, fake } = setup()
    fake.on(method, json([], 503), json({}, 200))
    const pending =
      method === 'GET'
        ? sage.api.GET('/contacts/{key}', { params: { path: { key: 'k' } } })
        : method === 'PUT'
          ? sage.api.PUT('/contacts/{key}', { params: { path: { key: 'k' } }, body: { contact: { name: 'B' } } })
          : sage.api.DELETE('/contacts/{key}', { params: { path: { key: 'k' } } })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await pending).response.status).toBe(200)
    expect(fake.calls).toHaveLength(2)
  })

  it('never retries a POST after a 5xx', async () => {
    const { sage, fake } = setup()
    fake.on('POST', json([{ $message: 'boom' }], 500))
    const result = await sage.api.POST('/sales_invoices', { body: { sales_invoice: { contact_id: 'c', date: '2026-10-14', invoice_lines: [] } } })
    expect(result.response.status).toBe(500)
    expect(fake.calls).toHaveLength(1)
  })

  it('never retries a POST after a 5xx, even when its body carries an idempotency_id', async () => {
    const { sage, fake } = setup()
    fake.on('POST', json([], 504), json({ id: 'inv-1' }, 201))
    const result = await sage.api.POST('/sales_invoices', {
      body: { sales_invoice: { contact_id: 'c', date: '2026-10-14', invoice_lines: [], idempotency_id: 'a'.repeat(32) } },
    })
    expect(result.response.status).toBe(504)
    expect(fake.calls).toHaveLength(1)
  })

  it('retries a network error on GET, but not on POST', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const get = setup()
    get.fake.on('GET', new TypeError('fetch failed'), ok())
    const pendingGet = get.sage.api.GET('/contacts')
    await vi.advanceTimersByTimeAsync(2000)
    expect((await pendingGet).response.status).toBe(200)
    expect(get.fake.calls).toHaveLength(2)

    const post = setup()
    post.fake.on('POST', new TypeError('fetch failed'), json({}, 201))
    await expect(post.sage.api.POST('/contacts', { body: { contact: { name: 'A', contact_type_ids: ['CUSTOMER'] } } })).rejects.toThrow('fetch failed')
    expect(post.fake.calls).toHaveLength(1)
  })

  it('times out each attempt', async () => {
    const { sage, fake } = setup({ timeoutMs: 20, retries: 0 })
    fake.on('GET', (request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason))) as never)
    await expect(sage.api.GET('/contacts')).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('does not retry when the caller aborts', async () => {
    const { sage, fake } = setup()
    const controller = new AbortController()
    fake.on('GET', () => {
      controller.abort(new Error('stop'))
      return new TypeError('aborted')
    })
    await expect(sage.api.GET('/contacts', { signal: controller.signal })).rejects.toThrow()
    expect(fake.calls).toHaveLength(1)
  })
})

describe('pagination', () => {
  const item = (id: string) => ({ id })

  it('follows $next over three pages, absolute or relative, with the same headers each time', async () => {
    const { sage, fake } = setup({}, storedToken({ businessId: 'biz-1' }))
    fake.on(
      'GET',
      json({ $items: [item('1'), item('2')], $next: `${BASE}/contacts?page=2&items_per_page=2` }),
      json({ $items: [item('3'), item('4')], $next: '/contacts?page=3&items_per_page=2' }),
      json({ $items: [item('5')], $next: null }),
    )
    const ids: (string | undefined)[] = []
    for await (const contact of sage.paginate('/contacts', { params: { query: { items_per_page: 2 } } })) ids.push(contact.id)
    expect(ids).toEqual(['1', '2', '3', '4', '5'])
    expect(fake.calls.map((c) => c.url)).toEqual([
      `${BASE}/contacts?items_per_page=2`,
      `${BASE}/contacts?page=2&items_per_page=2`,
      `${BASE}/contacts?page=3&items_per_page=2`,
    ])
    for (const call of fake.calls) {
      expect(call.headers.get('Authorization')).toBe('Bearer access-1')
      expect(call.headers.get('X-Business')).toBe('biz-1')
    }
  })

  it('accepts a $next that already includes the version prefix', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $items: [item('1')], $next: '/v3.1/contacts?page=2' }), json({ $items: [], $next: null }))
    for await (const _ of sage.paginate('/contacts')) void _
    expect(fake.calls[1]!.url).toBe(`${BASE}/contacts?page=2`)
  })

  it('refuses a $next on another origin and sends nothing there', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $items: [item('1')], $next: 'https://evil.test/contacts?page=2' }))
    const seen: unknown[] = []
    const walk = async () => {
      for await (const contact of sage.paginate('/contacts')) seen.push(contact)
    }
    await expect(walk()).rejects.toMatchObject({ name: 'SagePaginationError' })
    expect(seen).toHaveLength(1)
    expect(fake.calls).toHaveLength(1)
  })

  it('refuses a $next that leads back to a page already read', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $items: [item('1')], $next: '/contacts?page=2' }), json({ $items: [item('2')], $next: '/contacts?page=2' }))
    const walk = async () => {
      for await (const _ of sage.paginate('/contacts')) void _
    }
    await expect(walk()).rejects.toMatchObject({ name: 'SagePaginationError' })
  })

  it('throws SageApiError when a later page fails', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $items: [item('1')], $next: '/contacts?page=2' }), json([{ $message: 'bad page' }], 422))
    const walk = async () => {
      for await (const _ of sage.paginate('/contacts')) void _
    }
    await expect(walk()).rejects.toMatchObject({ name: 'SageApiError', status: 422, path: '/contacts' })
  })
})

describe('errors', () => {
  it('builds SageApiError from an array body', async () => {
    const { sage, fake } = setup()
    fake.on('POST', json([{ $severity: 'error', $dataCode: 'RecordInvalid', $message: 'name is required', $source: 'name' }, { $message: 'second' }], 422, { x_request_id: 'req-1' }))
    const error = await Promise.resolve(sage.api.POST('/contacts', { body: { contact: { name: '', contact_type_ids: ['CUSTOMER'] } } }))
      .then(assertOk)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SageApiError)
    const e = error as SageApiError
    expect(e).toMatchObject({ status: 422, method: 'POST', path: '/contacts', requestId: 'req-1' })
    expect(e.errors).toEqual([
      { $severity: 'error', $dataCode: 'RecordInvalid', $message: 'name is required', $source: 'name' },
      { $message: 'second' },
    ])
    expect(e.message).toBe('Sage API error (HTTP 422) on POST /contacts: name is required; second')
  })

  it('builds SageApiError from a single object body', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $severity: 'error', $message: 'Not found' }, 404))
    const e = (await Promise.resolve(sage.api.GET('/contacts/{key}', { params: { path: { key: 'nope' } } })).then(assertOk).catch((x: unknown) => x)) as SageApiError
    expect(e).toMatchObject({ status: 404, method: 'GET', path: '/contacts/nope' })
    expect(e.errors).toEqual([{ $severity: 'error', $message: 'Not found' }])
  })

  it('keeps a short copy of a body that is not JSON', async () => {
    const { sage, fake } = setup({ retries: 0 })
    fake.on('GET', new Response('x'.repeat(2000), { status: 502 }))
    const e = (await Promise.resolve(sage.api.GET('/contacts')).then(assertOk).catch((x: unknown) => x)) as SageApiError
    expect(e.errors).toEqual([])
    expect(String(e.body)).toHaveLength(500)
  })

  it('never puts a token or the client secret in an error, and never logs', async () => {
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}))
    const everything = (e: Error) => JSON.stringify({ ...e, message: e.message, stack: e.stack })
    const secrets = ['access-1', 'refresh-1', 'client-secret']

    // An API failure: the request carried the bearer token.
    const api = setup({ retries: 0 })
    api.fake.on('POST', json([{ $message: 'bad contact' }], 422))
    const apiError = (await Promise.resolve(api.sage.api.POST('/contacts', { body: { contact: { name: '', contact_type_ids: ['CUSTOMER'] } } })).then(assertOk).catch((x: unknown) => x)) as SageApiError
    expect(apiError.status).toBe(422)

    // A token failure: the request carried the refresh token and the client secret.
    const auth = setup({}, storedToken({ expiresAt: Date.now() - 1 }))
    auth.fake.on(TOKEN, json({ error: 'invalid_client', error_description: 'bad credentials' }, 400))
    const authError = (await auth.sage.api.GET('/contacts').catch((x: unknown) => x)) as Error
    expect(authError.name).toBe('SageAuthError')

    for (const error of [apiError, authError]) for (const secret of secrets) expect(everything(error), secret).not.toContain(secret)
    for (const spy of logged) expect(spy).not.toHaveBeenCalled()
  })

  it('keeps what Sage sent as it was sent, even if Sage echoes the Authorization header (the package adds nothing of its own)', async () => {
    const { sage, fake } = setup({ retries: 0 })
    fake.on('GET', (request) => new Response(`you sent ${request.headers.get('Authorization')}`, { status: 400 }))
    const e = (await Promise.resolve(sage.api.GET('/contacts')).then(assertOk).catch((x: unknown) => x)) as SageApiError
    expect(e.message).toBe('Sage API error (HTTP 400) on GET /contacts')
    expect(String(e.body)).toBe('you sent Bearer access-1')
  })

  it('assertOk returns data on success and undefined data for a 204', async () => {
    const { sage, fake } = setup()
    fake.on('GET', json({ $items: [{ id: 'c1' }], $next: null }))
    fake.on('DELETE', new Response(null, { status: 204 }))
    expect(assertOk(await sage.api.GET('/contacts')).$items[0]!.id).toBe('c1')
    expect(assertOk(await sage.api.DELETE('/contacts/{key}', { params: { path: { key: 'c1' } } }))).toBeUndefined()
  })
})
