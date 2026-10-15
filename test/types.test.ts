import { describe, expectTypeOf, it } from 'vitest'
import { assertOk, createSage, MemoryTokenStore, type components, type ItemOf, type paths } from '../src/index.js'

// These checks are made by `npm run typecheck` (tsc), which fails if a type is wrong.
// Running them under vitest only proves the file loads.

const sage = createSage({ clientId: 'a', clientSecret: 'b', redirectUri: 'https://x.test', tokenStore: new MemoryTokenStore() })
type Schemas = components['schemas']

describe('types come from Sage\'s spec', () => {
  it('types the body of POST /sales_invoices', () => {
    type Body = paths['/sales_invoices']['post']['requestBody']['content']['application/json']
    expectTypeOf<Body['sales_invoice']['contact_id']>().toEqualTypeOf<string>()
    expectTypeOf<Body['sales_invoice']['date']>().toEqualTypeOf<string>()
    expectTypeOf<Body['sales_invoice']['reference']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Body['sales_invoice']['idempotency_id']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Body['sales_invoice']['invoice_lines'][number]['ledger_account_id']>().toEqualTypeOf<string>()

    const call = () =>
      sage.api.POST('/sales_invoices', {
        // @ts-expect-error contact_id is a string, and invoice_lines is required
        body: { sales_invoice: { contact_id: 123, date: '2026-10-14' } },
      })
    void call
  })

  it('types list responses with the envelope after the patch', async () => {
    const call = async () => {
      const data = assertOk(await sage.api.GET('/sales_invoices'))
      expectTypeOf(data.$items).toEqualTypeOf<Schemas['SalesInvoice'][]>()
      expectTypeOf(data.$next).toEqualTypeOf<string | null | undefined>()
      expectTypeOf(data.$total).toEqualTypeOf<number | undefined>()
      const contacts = assertOk(await sage.api.GET('/contacts'))
      expectTypeOf(contacts.$items).toEqualTypeOf<Schemas['Contact'][]>()
      const businesses = assertOk(await sage.api.GET('/businesses'))
      expectTypeOf(businesses.$items[0]!.id).toEqualTypeOf<string | undefined>()
      const payments = assertOk(await sage.api.GET('/contact_payments'))
      expectTypeOf(payments.$items).toEqualTypeOf<Schemas['ContactPayment'][]>()
      const one = assertOk(await sage.api.GET('/contacts/{key}', { params: { path: { key: 'x' } } }))
      expectTypeOf(one).toEqualTypeOf<Schemas['Contact']>()
    }
    void call
  })

  it('types errors as Sage\'s error entries', async () => {
    const call = async () => {
      const result = await sage.api.GET('/sales_invoices')
      if (result.error) expectTypeOf(result.error).toEqualTypeOf<Schemas['SageError'][] | Schemas['SageError']>()
    }
    void call
  })

  it('keeps money as Sage sends it: a number or a numeric string', () => {
    expectTypeOf<Schemas['SalesInvoice']['total_amount']>().toEqualTypeOf<number | string | undefined>()
  })

  it('gives paginate the item type of the list', () => {
    expectTypeOf<ItemOf<'/sales_invoices'>>().toEqualTypeOf<Schemas['SalesInvoice']>()
    expectTypeOf<ItemOf<'/currencies'>>().toEqualTypeOf<unknown>() // Sage's spec has no schema for it
    const call = async () => {
      for await (const invoice of sage.paginate('/sales_invoices')) expectTypeOf(invoice).toEqualTypeOf<Schemas['SalesInvoice']>()
    }
    void call
  })
})
