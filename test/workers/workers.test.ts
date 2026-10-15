import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertOk, createSage, toPence } from '../../src/index.js'
import { D1TokenStore, SCHEMA } from '../../examples/d1-token-store.js'
import { BASE, fakeFetch, json, storedToken, tokenReply } from '../helpers/fake-fetch.js'

// These run inside workerd with a real D1 binding. (The test runner turns Node
// compatibility on, so test/bare-workerd.test.ts is the proof of no Node built-ins.)

const store = () => new D1TokenStore(env.DB)

beforeEach(async () => {
  await env.DB.prepare(SCHEMA).run()
  await env.DB.prepare('DELETE FROM sage_token').run()
})

describe('in workerd', () => {
  it('builds the authorise URL with a random state', () => {
    const sage = createSage({ clientId: 'id', clientSecret: 's', redirectUri: 'https://w.test/callback', tokenStore: store() })
    const { url, state } = sage.authorizationUrl()
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new URL(url).searchParams.get('state')).toBe(state)
  })

  it('connects, refreshes and pages through a D1 token store', async () => {
    const fake = fakeFetch()
    const sage = createSage({ clientId: 'id', clientSecret: 's', redirectUri: 'https://w.test/callback', tokenStore: store(), fetch: fake.fetch })
    fake.on('/token', tokenReply('access-1', 'refresh-1', 1), tokenReply('access-2', 'refresh-2'))
    await sage.handleCallback('https://w.test/callback?code=c&state=x', 'x')
    await sage.selectBusiness('biz-1')

    fake.on('GET', json({ $items: [{ id: '1' }], $next: '/contacts?page=2' }), json({ $items: [{ id: '2' }], $next: null }))
    const ids: (string | undefined)[] = []
    for await (const contact of sage.paginate('/contacts')) ids.push(contact.id) // access-1 had 1s left, so this refreshes first
    expect(ids).toEqual(['1', '2'])
    expect(fake.to('/token')).toHaveLength(2)
    expect(fake.to('/contacts').every((c) => c.headers.get('X-Business') === 'biz-1')).toBe(true)
    expect(fake.to('/contacts')[0]!.headers.get('Authorization')).toBe('Bearer access-2')
    expect(await store().get()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', businessId: 'biz-1', scope: 'full_access' })
  })

  it('shares one refresh between concurrent calls', async () => {
    await store().put(storedToken({ expiresAt: Date.now() - 1 }), null)
    const fake = fakeFetch()
    const sage = createSage({ clientId: 'id', clientSecret: 's', redirectUri: 'https://w.test/callback', tokenStore: store(), fetch: fake.fetch })
    fake.on('/token', tokenReply('access-2', 'refresh-2')).on('GET', json({ $items: [], $next: null }))
    await Promise.all([sage.api.GET('/contacts'), sage.api.GET('/products')])
    expect(fake.to('/token')).toHaveLength(1)
  })

  it('reads Sage errors', async () => {
    await store().put(storedToken(), null)
    const fake = fakeFetch()
    const sage = createSage({ clientId: 'id', clientSecret: 's', redirectUri: 'https://w.test/callback', tokenStore: store(), fetch: fake.fetch, retries: 0 })
    fake.on('GET', json([{ $message: 'No such contact' }], 404))
    const result = await sage.api.GET('/contacts/{key}', { params: { path: { key: 'x' } } })
    expect(() => assertOk(result)).toThrow(`Sage API error (HTTP 404) on GET ${new URL(`${BASE}/contacts/x`).pathname.replace('/v3.1', '')}: No such contact`)
  })

  it('turns Sage money into pence', () => {
    expect(toPence('120.00')).toBe(12000)
  })
})

describe('the D1 token store', () => {
  it('only lets one writer win a refresh', async () => {
    const first = storedToken()
    expect(await store().put(first, null)).toBe(true)
    expect(await store().put(storedToken({ refreshToken: 'other' }), null)).toBe(false)

    const second = storedToken({ accessToken: 'access-2', refreshToken: 'refresh-2' })
    expect(await store().put(second, first)).toBe(true)
    expect(await store().put(storedToken({ refreshToken: 'refresh-late' }), first)).toBe(false)
    expect(await store().get()).toMatchObject({ refreshToken: 'refresh-2' })

    await store().forget()
    expect(await store().get()).toBeNull()
  })
})
