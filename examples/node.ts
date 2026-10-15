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
