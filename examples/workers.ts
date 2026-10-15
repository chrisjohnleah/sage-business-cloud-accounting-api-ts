import { assertOk, createSage, SageAuthError } from 'sage-business-cloud-accounting-api'
import { D1TokenStore, type D1Like } from './d1-token-store.js'

interface Env {
  DB: D1Like
  SAGE_CLIENT_ID: string
  SAGE_CLIENT_SECRET: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const sage = createSage({
      clientId: env.SAGE_CLIENT_ID,
      clientSecret: env.SAGE_CLIENT_SECRET,
      redirectUri: `${url.origin}/callback`,
      scope: 'full_access',
      tokenStore: new D1TokenStore(env.DB),
    })

    // Someone with Sage access visits /connect once.
    if (url.pathname === '/connect') {
      const { url: sageUrl, state } = sage.authorizationUrl()
      return new Response(null, {
        status: 302,
        headers: {
          Location: sageUrl,
          'Set-Cookie': `sage_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/callback`,
        },
      })
    }

    // Sage sends them back here.
    if (url.pathname === '/callback') {
      const expectedState = /(?:^|; )sage_state=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1] ?? ''
      try {
        await sage.handleCallback(request.url, expectedState)
      } catch (error) {
        if (error instanceof SageAuthError) return new Response(`Could not connect: ${error.code}`, { status: 400 })
        throw error
      }
      const [business] = await sage.listBusinesses()
      if (business?.id) await sage.selectBusiness(business.id)
      return new Response('Connected to Sage.')
    }

    // Everything else just uses the stored connection.
    if (url.pathname === '/unpaid') {
      const names: string[] = []
      for await (const invoice of sage.paginate('/sales_invoices', { params: { query: { items_per_page: 100, attributes: 'all' } } })) {
        if (Number(invoice.outstanding_amount) > 0) names.push(invoice.displayed_as ?? '')
      }
      return Response.json(names)
    }

    const me = assertOk(await sage.api.GET('/user'))
    return Response.json({ connectedAs: me.email })
  },
}
