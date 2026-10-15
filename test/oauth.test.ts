import { describe, expect, it } from 'vitest'
import { MemoryTokenStore, SageAuthError, SageNotConnectedError, type TokenStore } from '../src/index.js'
import { json, setup, tokenReply, storedToken } from './helpers/fake-fetch.js'

const callback = (query: string) => `https://app.test/callback?${query}`

describe('authorizationUrl', () => {
  it('carries every parameter Sage needs', () => {
    const { sage } = setup({ scope: 'full_access', country: 'ie' })
    const { url, state } = sage.authorizationUrl({ state: 'fixed-state' })
    const parsed = new URL(url)
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://www.sageone.com/oauth2/auth/central')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-id',
      redirect_uri: 'https://app.test/callback',
      scope: 'full_access',
      state: 'fixed-state',
      filter: 'apiv3.1',
      country: 'ie',
    })
    expect(state).toBe('fixed-state')
  })

  it('defaults to readonly and gb, and makes 32 random bytes of state', () => {
    const { sage } = setup()
    const first = sage.authorizationUrl()
    const second = sage.authorizationUrl()
    const params = new URL(first.url).searchParams
    expect(params.get('scope')).toBe('readonly')
    expect(params.get('country')).toBe('gb')
    expect(params.get('state')).toBe(first.state)
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.state).not.toBe(second.state)
  })
})

describe('handleCallback', () => {
  it('exchanges the code and stores the token with expiresAt', async () => {
    const { sage, fake, store } = setup({}, null)
    fake.on('POST https://oauth.accounting.sage.com/token', tokenReply('access-new', 'refresh-new', 300))
    const before = Date.now()
    await sage.handleCallback(callback('code=GB%2Fabc&country=GB&state=s1'), 's1')
    const stored = await store.get()
    expect(stored).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new', businessId: null, scope: 'full_access' })
    expect(stored!.expiresAt).toBeGreaterThanOrEqual(before + 300_000)
    expect(stored!.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000)

    const [call] = fake.to('/token')
    expect(call!.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(call!.body))).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'authorization_code',
      code: 'GB/abc',
      redirect_uri: 'https://app.test/callback',
    })
    expect(call!.headers.has('Authorization')).toBe(false)
  })

  it('refuses a state that does not match, without calling Sage', async () => {
    const { sage, fake } = setup({}, null)
    await expect(sage.handleCallback(callback('code=c&state=other'), 's1')).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fake.calls).toHaveLength(0)
  })

  it('refuses a missing state, or a missing expected state', async () => {
    const { sage, fake } = setup({}, null)
    await expect(sage.handleCallback(callback('code=c'), 's1')).rejects.toBeInstanceOf(SageAuthError)
    await expect(sage.handleCallback(callback('code=c&state=s1'), '')).rejects.toBeInstanceOf(SageAuthError)
    expect(fake.calls).toHaveLength(0)
  })

  it('turns ?error= into a SageAuthError', async () => {
    const { sage } = setup({}, null)
    const attempt = sage.handleCallback(callback('error=access_denied&error_description=No%20thanks&state=s1'), 's1')
    await expect(attempt).rejects.toMatchObject({ name: 'SageAuthError', code: 'access_denied', description: 'No thanks' })
  })

  it('refuses a callback with no code', async () => {
    const { sage } = setup({}, null)
    await expect(sage.handleCallback(callback('state=s1'), 's1')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('surfaces a refusal from the token endpoint', async () => {
    const { sage, fake } = setup({}, null)
    fake.on('/token', json({ error: 'invalid_grant', error_description: 'code expired' }, 400))
    await expect(sage.handleCallback(callback('code=c&state=s1'), 's1')).rejects.toMatchObject({
      code: 'invalid_grant',
      description: 'code expired',
      status: 400,
    })
  })

  it('keeps the chosen business when the new login can still reach it', async () => {
    const { sage, fake, store } = setup({}, storedToken({ businessId: 'biz-1' }))
    fake.on('/token', tokenReply('access-2', 'refresh-2'))
    fake.on('/businesses', json({ $items: [{ id: 'biz-0' }, { id: 'biz-1' }], $next: null }))
    await sage.handleCallback(callback('code=c&state=s1'), 's1')
    expect(await store.get()).toMatchObject({ accessToken: 'access-2', businessId: 'biz-1' })
    // the business list was fetched with the new token and without X-Business
    expect(fake.to('/businesses')[0]!.headers.get('Authorization')).toBe('Bearer access-2')
    expect(fake.to('/businesses')[0]!.headers.has('X-Business')).toBe(false)
  })

  it('forgets the chosen business when the new login is a different one that cannot reach it', async () => {
    const { sage, fake, store } = setup({}, storedToken({ businessId: 'biz-1' }))
    fake.on('/token', tokenReply('access-2', 'refresh-2'))
    fake.on('/businesses', json({ $items: [{ id: 'other-1' }], $next: null }))
    await sage.handleCallback(callback('code=c&state=s1'), 's1')
    expect(await store.get()).toMatchObject({ accessToken: 'access-2', businessId: null })
  })

  it('throws when the new connection cannot be saved, instead of pretending it is connected', async () => {
    const old = storedToken()
    const store: TokenStore = { get: () => old, put: () => false, forget: () => {} }
    const { sage, fake } = setup({ tokenStore: store })
    fake.on('/token', tokenReply('access-2', 'refresh-2'))
    await expect(sage.handleCallback(callback('code=c&state=s1'), 's1')).rejects.toBeInstanceOf(SageNotConnectedError)
  })

  it('saves the connection on a second try when the first compare and swap is lost', async () => {
    const inner = new MemoryTokenStore(storedToken())
    let refused = false
    const store: TokenStore = {
      get: () => inner.get(),
      put: (next, previous) => {
        if (!refused) {
          refused = true
          inner.put(storedToken({ refreshToken: 'refresh-other' }), inner.get())
          return false
        }
        return inner.put(next, previous)
      },
      forget: () => inner.forget(),
    }
    const { sage, fake } = setup({ tokenStore: store })
    fake.on('/token', tokenReply('access-2', 'refresh-2'))
    await sage.handleCallback(callback('code=c&state=s1'), 's1')
    expect(inner.get()).toMatchObject({ refreshToken: 'refresh-2' })
  })

  it('never puts the secret, code or state in an error message', async () => {
    const { sage, fake } = setup({}, null)
    fake.on('/token', json({ error: 'invalid_client' }, 401))
    const error = await sage.handleCallback(callback('code=secret-code&state=secret-state'), 'secret-state').catch((e: Error) => e)
    expect(String(error)).not.toMatch(/secret-code|secret-state|client-secret/)
  })
})

describe('disconnect', () => {
  it('forgets the token', async () => {
    const { sage, store } = setup()
    await sage.disconnect()
    expect(await store.get()).toBeNull()
  })

  it('can revoke the refresh token first', async () => {
    const { sage, fake, store } = setup()
    fake.on('POST https://oauth.accounting.sage.com/revoke', json({ success: 'ok' }))
    await sage.disconnect({ revoke: true })
    expect(Object.fromEntries(new URLSearchParams(fake.to('/revoke')[0]!.body))).toMatchObject({ token: 'refresh-1', client_id: 'client-id' })
    expect(await store.get()).toBeNull()
  })

  it('forgets even when revoking fails', async () => {
    const { sage, fake, store } = setup()
    fake.on('/revoke', json({ error: 'invalid_client' }, 401))
    await expect(sage.disconnect({ revoke: true })).rejects.toBeInstanceOf(SageAuthError)
    expect(await store.get()).toBeNull()
  })
})

describe('MemoryTokenStore', () => {
  it('only accepts a put whose previous refresh token is still stored', () => {
    const first = storedToken()
    const store = new MemoryTokenStore(first)
    expect(store.put(storedToken({ refreshToken: 'refresh-2' }), first)).toBe(true)
    expect(store.put(storedToken({ refreshToken: 'refresh-3' }), first)).toBe(false)
    expect(store.get()!.refreshToken).toBe('refresh-2')
  })

  it('accepts the first put against nothing', () => {
    const store = new MemoryTokenStore()
    expect(store.put(storedToken(), null)).toBe(true)
    expect(store.put(storedToken(), null)).toBe(false)
  })
})
