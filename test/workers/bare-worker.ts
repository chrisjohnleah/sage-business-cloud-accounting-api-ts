// Runs in plain workerd with no compatibility flags (so no Node built-ins).
// test/bare-workerd.test.ts bundles this file and drives it with Miniflare.
import { assertOk, createSage, MemoryTokenStore, toPence } from '../../src/index.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export default {
  async fetch(): Promise<Response> {
    const seen: string[] = []
    const sage = createSage({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://w.test/callback',
      tokenStore: new MemoryTokenStore(),
      fetch: async (request) => {
        const url = new URL(request.url)
        seen.push(`${request.method} ${url.pathname}${url.search} ${request.headers.get('Authorization') ?? '-'}`)
        if (url.pathname === '/token') {
          return json({ access_token: 'a1', refresh_token: 'r1', expires_in: 300, token_type: 'bearer' })
        }
        if (url.searchParams.get('page') === '2') return json({ $items: [{ id: '2' }], $next: null })
        return json({ $items: [{ id: '1' }], $next: '/contacts?page=2' })
      },
    })
    const { state } = sage.authorizationUrl()
    await sage.handleCallback(`https://w.test/callback?code=c&state=${state}`, state)
    const ids: (string | undefined)[] = []
    for await (const contact of sage.paginate('/contacts')) ids.push(contact.id)
    const first = assertOk(await sage.api.GET('/contacts'))
    return Response.json({ ids, firstPage: first.$items.length, pence: toPence('1,00'.replace(',', '.')), seen })
  },
}
