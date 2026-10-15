# sage-business-cloud-accounting-api

A TypeScript SDK for the [Sage Business Cloud Accounting API v3.1](https://developer.sage.com/accounting/). Every path, parameter and body is typed from Sage's own OpenAPI spec. It handles the OAuth dance, Sage's single use refresh tokens, `X-Business`, pagination and retries, and it runs anywhere `fetch` does: Node 20 and later, Cloudflare Workers, Deno and Bun.

This is the TypeScript sibling of the [PHP SDK](https://github.com/chrisjohnleah/sage-business-cloud-accounting-api) by the same author. It follows the PHP SDK's behaviour and fixes the places where that SDK had no answer yet (concurrent refreshes, `Retry-After`, errors, the state check).

- One runtime dependency, [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/). Everything else is in this package.
- ESM only. No Node built-ins anywhere in the source (a test fails if one appears, and another runs the package in workerd with no Node compatibility).
- Not affiliated with or endorsed by The Sage Group plc. "Sage" is a trademark of its owner.

## Install

```sh
npm install sage-business-cloud-accounting-api
```

You need a Sage developer app (client id, client secret and a registered redirect URI) from [developerselfservice.sageone.com](https://developerselfservice.sageone.com).

## Quick start: Cloudflare Workers

Sage rotates the refresh token every time you use it, so the token has to live somewhere that survives between requests. D1 is a good fit because it can do a compare and swap. This table and store are in [`examples/d1-token-store.ts`](examples/d1-token-store.ts):

```ts
// examples/d1-token-store.ts
import type { StoredToken, TokenStore } from 'sage-business-cloud-accounting-api'

/** The slice of Cloudflare's D1 binding this store needs. The real `D1Database` fits. */
export interface D1Like {
  prepare(sql: string): D1Statement
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
}

/** Run this once, for example in a D1 migration. One connection, so one row. */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS sage_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  business_id TEXT,
  scope TEXT
)`

interface Row {
  access_token: string
  refresh_token: string
  expires_at: number
  business_id: string | null
  scope: string | null
}

export class D1TokenStore implements TokenStore {
  constructor(private readonly db: D1Like) {}

  async get(): Promise<StoredToken | null> {
    const row = await this.db
      .prepare('SELECT access_token, refresh_token, expires_at, business_id, scope FROM sage_token WHERE id = 1')
      .first<Row>()
    if (!row) return null
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      businessId: row.business_id,
      ...(row.scope ? { scope: row.scope } : {}),
    }
  }

  /** Compare and swap: the row only changes if it still holds the refresh token and business we started from. */
  async put(next: StoredToken, previous: StoredToken | null): Promise<boolean> {
    const values = [next.accessToken, next.refreshToken, next.expiresAt, next.businessId, next.scope ?? null]
    const result = previous
      ? await this.db
          .prepare(
            'UPDATE sage_token SET access_token = ?, refresh_token = ?, expires_at = ?, business_id = ?, scope = ? WHERE id = 1 AND refresh_token = ? AND business_id IS ?',
          )
          .bind(...values, previous.refreshToken, previous.businessId)
          .run()
      : await this.db
          .prepare(
            'INSERT INTO sage_token (id, access_token, refresh_token, expires_at, business_id, scope) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
          )
          .bind(...values)
          .run()
    return result.meta.changes === 1
  }

  async forget(): Promise<void> {
    await this.db.prepare('DELETE FROM sage_token WHERE id = 1').run()
  }
}
```

Then a Worker that connects, remembers the connection and reads invoices ([`examples/workers.ts`](examples/workers.ts)):

```ts
// examples/workers.ts
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
```

Workers KV cannot do a compare and swap, because writes are eventually consistent and there is no conditional put. If you use KV, two Workers refreshing at the same moment can both succeed locally and leave KV holding a refresh token Sage has already retired. Use D1 or a Durable Object.

## Quick start: Node

[`examples/node.ts`](examples/node.ts) connects from the terminal, picks a business, reads contacts and creates an invoice safely:

```ts
// examples/node.ts
import { createInterface } from 'node:readline/promises'
import { assertOk, createSage, MemoryTokenStore, newIdempotencyId, toPence } from 'sage-business-cloud-accounting-api'

const sage = createSage({
  clientId: process.env.SAGE_CLIENT_ID ?? '',
  clientSecret: process.env.SAGE_CLIENT_SECRET ?? '',
  redirectUri: 'http://127.0.0.1:8765/callback',
  scope: 'full_access',
  // Fine for a script. Anything that restarts needs a store that persists (see the Workers example).
  tokenStore: new MemoryTokenStore(),
})

// 1. Connect once: open the URL, approve, then paste the address the browser lands on.
const { url, state } = sage.authorizationUrl()
console.log(`Open this in a browser:\n${url}\n`)
const terminal = createInterface({ input: process.stdin, output: process.stdout })
await sage.handleCallback(await terminal.question('Paste the full address you were sent to: '), state)
terminal.close()

// 2. Pick the business.
const [business] = await sage.listBusinesses()
if (!business?.id) throw new Error('This Sage login has no businesses.')
await sage.selectBusiness(business.id)

// 3. Read.
const customers = assertOk(await sage.api.GET('/contacts', { params: { query: { contact_type_id: 'CUSTOMER', items_per_page: 5 } } }))
console.log(customers.$items.map((contact) => contact.displayed_as))

// 4. Create an invoice without ever making a duplicate: look for the reference first,
//    and send an idempotency_id so that if you ever repeat this exact request, Sage returns the first result.
const reference = 'JOB-1042'
const existing = assertOk(await sage.api.GET('/sales_invoices', { params: { query: { search: reference } } }))
const found = existing.$items.find((invoice) => invoice.reference === reference)
const invoice =
  found ??
  assertOk(
    await sage.api.POST('/sales_invoices', {
      body: {
        sales_invoice: {
          idempotency_id: newIdempotencyId(),
          contact_id: customers.$items[0]?.id ?? '',
          date: '2026-10-14',
          reference,
          invoice_lines: [{ description: 'Roller blind, fitted', ledger_account_id: 'your-sales-ledger-id', unit_price: 120, quantity: 1 }],
        },
      },
    }),
  )

// 5. Money arrives as a number or a numeric string. Turn it into whole pence before adding anything up.
console.log(invoice.displayed_as, toPence(invoice.total_amount ?? 0))
```

`MemoryTokenStore` forgets everything when the process stops. For anything that restarts, write a store that saves to a file or a database (see the token store section).

## The connect flow

A person with Sage access does this once. After that the stored refresh token keeps the connection alive for as long as it is used at least once every 31 days.

```ts
// examples/connect.ts
import type { Sage } from 'sage-business-cloud-accounting-api'

/** Step one: send the person to `url`, and keep `state` somewhere that survives the round trip (a cookie, a session, a database row). */
export function startConnect(sage: Sage) {
  return sage.authorizationUrl()
}

/** Step two: `callbackUrl` is the full address Sage sent the person back to. */
export async function finishConnect(sage: Sage, callbackUrl: string, state: string) {
  await sage.handleCallback(callbackUrl, state)
}
```

`authorizationUrl()` makes 32 random bytes of `state` (base64url) unless you pass your own with `authorizationUrl({ state })`. `handleCallback` then:

1. refuses a missing or different `state` (compared in constant time) with a `SageAuthError` whose `code` is `state_mismatch`, before it talks to Sage;
2. turns `?error=access_denied&error_description=...` into a `SageAuthError` with that `code` and `description`;
3. trades the code for tokens (Sage's codes are single use and last 60 seconds) and stores them. If the store refuses the new token it tries again, then throws `SageNotConnectedError`; it never reports a connection it did not save.

The authorise URL carries `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `filter=apiv3.1` and `country`. `scope` is `readonly` by default; pass `scope: 'full_access'` to write. `country` is `gb` by default (`ie` and `ca` also work). The client id and secret go in the body of the token request, as Sage's [authentication guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/authenticating/authentication) shows.

`await sage.disconnect()` forgets the stored token. `await sage.disconnect({ revoke: true })` first asks Sage to retire the refresh token, using the revoke endpoint in the same guide (`POST https://oauth.accounting.sage.com/revoke` with `client_id`, `client_secret` and `token`). The stored token is forgotten even if that request fails.

## Choosing a business

```ts
// examples/business.ts
import type { Sage } from 'sage-business-cloud-accounting-api'

/** Picks the first business this Sage login can reach. A real app would let the person choose. */
export async function chooseBusiness(sage: Sage) {
  const [business] = await sage.listBusinesses()
  if (!business?.id) throw new Error('This Sage login has no businesses.')
  await sage.selectBusiness(business.id)
}
```

The chosen id is kept on the stored token, survives refreshes, and is sent as `X-Business` on every API call (never on token calls). Reconnecting keeps it only if the new login can reach that business (`handleCallback` checks `listBusinesses()`); otherwise it is cleared and you choose again. Sage's [best practices guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/best-practices) says the header is optional, since without it Sage uses the person's "lead business" (the first business they created), but also says to always send it in production because the lead business can change.

## Typed calls

`sage.api` is an openapi-fetch client over Sage's spec. Paths, query parameters, bodies and responses are all checked by TypeScript, and every call gets its `Authorization` header, token refresh, retries and `X-Business` for free.

```ts
// examples/typed-calls.ts
import { assertOk, type Sage } from 'sage-business-cloud-accounting-api'

export async function typedCalls(sage: Sage, ledgerAccountId: string) {
  const contacts = assertOk(await sage.api.GET('/contacts', { params: { query: { search: 'Acme', contact_type_id: 'CUSTOMER' } } }))
  const customer = contacts.$items[0]
  if (!customer?.id) return null

  // The body is checked against Sage's spec: a misspelt field or a missing required one is a compile error.
  return assertOk(
    await sage.api.POST('/sales_invoices', {
      body: {
        sales_invoice: {
          contact_id: customer.id,
          date: '2026-10-14',
          invoice_lines: [{ description: 'Roller blind, fitted', ledger_account_id: ledgerAccountId, unit_price: 120, quantity: 1 }],
        },
      },
    }),
  )
}
```

A call resolves to `{ data, error, response }`. `assertOk(result)` returns `data` or throws a `SageApiError`. If you would rather branch on `error` yourself, do; it is typed too. Network failures and timeouts are thrown as the underlying error.

The types are generated from Sage's spec, which is vendored in `openapi/sage-accounting-3.1.0.json`. That file is Sage's and belongs to Sage. See the section on the spec patch below for what is changed before the types are made.

## Pagination

```ts
// examples/paginate.ts
import type { Sage } from 'sage-business-cloud-accounting-api'

/** Every invoice changed since a date, 200 at a time. */
export async function changedInvoices(sage: Sage, since: string) {
  const invoices = []
  for await (const invoice of sage.paginate('/sales_invoices', { params: { query: { updated_or_created_since: since, items_per_page: 200 } } })) {
    invoices.push(invoice)
  }
  return invoices
}
```

`paginate` follows `$next` until it is empty. Sage's guide shows `$next` as a path such as `/contacts?page=2`; some clients have seen a full URL. Both work. A `$next` that points at any other origin than the base URL is refused with a `SagePaginationError`, because the bearer token goes with every request. So is a `$next` that leads back to a page already read. `items_per_page` is up to 200 (the spec says so for `/contacts`, and Sage's best practices guide gives 200 as the maximum).

Sage has no webhooks. Poll with `updated_or_created_since` (and `deleted_since`) and keep the time of your last successful run.

## Errors

| Error | When |
| --- | --- |
| `SageApiError` | `assertOk` or `paginate` met an error status. Has `status`, `errors` (Sage's `$severity`, `$dataCode`, `$message` and `$source`, whether Sage sent an array or one object), `method`, `path`, `body` and `requestId`. Quote `requestId` to Sage support. It never holds the token. |
| `SageAuthError` | Sage's token endpoint refused (`code` is its OAuth error, such as `invalid_client`), the callback carried an error, or the state was wrong. |
| `SageNotConnectedError` | There is no stored token, Sage will no longer accept the stored refresh token (older than 31 days unused, or revoked), or a new token could not be saved. A person has to connect again. |
| `SagePaginationError` | `$next` pointed somewhere unsafe or in a circle. |

No error this package builds contains an access token, refresh token, authorisation code, client secret or state, and the package never logs anything (tests check both). If Sage itself echoes something back in an error body, that text is kept as Sage sent it, cut to 500 characters when it is not JSON.

## Retries, and the rule for POST

| Situation | What happens |
| --- | --- |
| `429` on any method | Waits `Retry-After` (seconds or an HTTP date), or else backs off exponentially with jitter from 1 second. At most `retries` times (default 3). |
| `5xx`, network error or timeout on GET, HEAD, PUT or DELETE | Repeated, up to `retries` times. |
| `5xx`, network error or timeout on POST | **Never repeated by this package**, because the request may already have reached Sage and a second one could create a second record. This holds even if the body carries an `idempotency_id`. |
| `401` | Refreshes the token once (unless another process just did) and repeats the request once. |

PUT is repeated because HTTP says it is safe to repeat, but Sage's [idempotency guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/idempotency) points out that a PUT can still have side effects (a new transaction, an email) and says to use `idempotency_id` on updates if that matters to you.

Each attempt has its own timeout (`timeoutMs`, 30 seconds by default) and also stops if the `signal` you passed aborts. If Sage asks for a wait longer than `maxRetryDelayMs` (default 60 seconds; Sage's [response codes guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/response-codes) warns that a 429 can mean waiting up to 24 hours), the 429 is returned straight away instead of holding your request open.

**Creating things safely.** Sage's [idempotency guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/idempotency) lists the resources that accept an `idempotency_id` (sales invoices, contacts, payments and many more). Put a random 32 character id inside the entity, made by the client, and for the next 7 days Sage returns the first result if the same request arrives again instead of creating a second record. Sage's spec leaves the field out, so this package adds it to the request types for the listed resources, and `newIdempotencyId()` makes a suitable id.

This package does not repeat a POST for you even when the id is there. If you want to repeat one yourself after a `5xx`, a network error or a timeout, send the same body with the same id each time (the id is made once, outside the loop):

```ts
// examples/create-safely.ts
import { assertOk, newIdempotencyId, SageApiError, type Sage } from 'sage-business-cloud-accounting-api'

/**
 * The package never repeats a POST by itself. To repeat one yourself after a 5xx, a network
 * error or a timeout, send the same body, with the same idempotency_id, every time.
 */
export async function createInvoice(sage: Sage, contactId: string, ledgerAccountId: string) {
  const body = {
    sales_invoice: {
      idempotency_id: newIdempotencyId(), // made once, outside the loop
      contact_id: contactId,
      date: '2026-10-14',
      reference: 'JOB-1042',
      invoice_lines: [{ description: 'Roller blind, fitted', ledger_account_id: ledgerAccountId, unit_price: 120, quantity: 1 }],
    },
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return assertOk(await sage.api.POST('/sales_invoices', { body }))
    } catch (error) {
      // Sage answered with a 4xx: repeating cannot help. Anything else may have reached Sage.
      const gaveAnAnswer = error instanceof SageApiError && error.status < 500
      if (gaveAnAnswer || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}
```

Without an id, search before you create: look up the `reference` (`GET /sales_invoices?search=JOB-1042`) and only create when it is not there. The Node example above does both. Sage's response codes guide notes that after an unhandled `500` on a POST the record may still have been created, so check before you try again.

## Rate limits

Sage's [best practices guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/best-practices) gives 1,296,000 requests per app per day and 150 concurrent requests per app, and its response codes guide says a 429 can mean waiting up to 24 hours. The PHP SDK this one follows throttles itself more tightly, to 100 requests a minute and 2,500 a day per business. This package does not throttle on its own; it honours 429 as described above. The same best practices guide asks you not to send parallel POSTs to `contacts`, `products`, the sales and purchase document endpoints and a few others, because of the references and numbering they generate, so create those one at a time.

## Token lifetimes, and writing a token store

- An access token lasts 5 minutes. The token is refreshed lazily, when it expires within `refreshBufferSeconds` (default 60).
- A refresh token is single use: every refresh returns a new one. It dies after 31 days without use (Sage's [authentication guide](https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/authenticating/authentication) gives both lifetimes).

```ts
interface StoredToken { accessToken: string; refreshToken: string; expiresAt: number; businessId: string | null; scope?: string }

interface TokenStore {
  get(): StoredToken | null | Promise<StoredToken | null>
  put(next: StoredToken, previous: StoredToken | null): boolean | void | Promise<boolean | void>
  forget(): void | Promise<void>
}
```

`expiresAt` is epoch milliseconds. `put` must save `next` **only if the stored token is still `previous`**, and return `false` when it is not. Compare the refresh token, and the business id too if you can, so that a business chosen while a refresh is in flight is not overwritten. That is how two processes (two Workers, two servers) avoid fighting over a single use refresh token. The D1 example does it with `UPDATE ... WHERE refresh_token = ? AND business_id IS ?`. A store that cannot compare and swap and always returns `true` still works for a single process.

What the package does with it:

- Inside one process, concurrent calls share one refresh request. It reads the store again just before it asks Sage, so a refresh token that has already been used is never sent twice.
- After Sage answers, it reads the store again for the business id (so a `selectBusiness` made meanwhile is kept) and saves the rotated token. If `put` returns `false` it reads the store again and uses the token it finds there if that is fresh, or tries again, and after three tries it throws `SageNotConnectedError` rather than hand back a token it could not save.
- If `disconnect()` ran while a refresh was in flight, the store stays empty and the call throws `SageNotConnectedError`.
- If Sage answers `invalid_grant` to a refresh, it reads the store again. A different refresh token there means another process won, so it uses that one. Otherwise it throws `SageNotConnectedError`.
- It never calls `forget` by itself.

## Money

Sage sends amounts as numbers or as numeric strings (`367.09` or `"367.09"`), and the types say so: money fields are `number | string`. Do not add them up with `+`. `toPence` turns one into whole pence with string parsing, never float arithmetic:

```ts
// examples/money.ts
import { toPence } from 'sage-business-cloud-accounting-api'

toPence('120.00') // 12000
toPence(120) // 12000
toPence('0.5') // 50
toPence('-3.20') // -320
```

It throws a `RangeError` rather than guess: for `"1,234.56"` (is that a thousands separator or a decimal comma?), for a third decimal place that is not zero (`"0.125"`), for exponent notation, and for anything beyond `Number.MAX_SAFE_INTEGER` pence.

## What the spec patch fixes

`npm run generate` runs `scripts/patch-spec.mjs` over Sage's spec and then generates `src/generated/sage.ts`, which is committed so you never have to. Each fix is commented in the script:

- **List endpoints return an envelope**, `{ $total, $page, $next, $back, $itemsPerPage, $items }`, not the bare array the spec declares. Every list GET is wrapped. (Sage's own examples spell the page size `$itemsPerPage` and, once, `$items_per_page`, so both are typed.)
- **GETs with no response schema** (`/businesses`, `/contacts`, `/contacts/{key}`, `/contact_payments` and others) are pointed at the matching component schema where there is one. Endpoints with no schema in the spec stay `unknown`.
- **Errors**: the spec has none. A `SageError` schema (`$severity`, `$dataCode`, `$message`, `$source`) is added as the `4XX` response of every operation, so `error` is typed.
- **Money is `number | string`** in responses, as the API sends it. Only money fields (amounts, prices, totals, balances, tax, discounts and the like) are changed; quantities, rates, percentages and weights stay `number`.
- **`idempotency_id`** is added to the request bodies of the resources Sage's idempotency guide lists.

Run `npm run check:generated` to check that the committed file matches the script.

## Options

| Option | Default | |
| --- | --- | --- |
| `clientId`, `clientSecret`, `redirectUri` | required | From your Sage app. The redirect URI must match exactly. |
| `tokenStore` | required | Where the connection lives. |
| `scope` | `readonly` | Or `full_access`. |
| `country` | `gb` | `gb`, `ie` or `ca`. |
| `fetch` | global `fetch` | Takes a `Request`. |
| `baseUrl` | `https://api.accounting.sage.com/v3.1` | |
| `refreshBufferSeconds` | 60 | |
| `retries` | 3 | |
| `timeoutMs` | 30000 | Per attempt. |
| `maxRetryDelayMs` | 60000 | Longest wait before a 429 is handed back instead. |
| `userAgent` | `sage-business-cloud-accounting-api-ts/<version>` | |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## Licence

MIT. Copyright 2026 Chris John Leah.
