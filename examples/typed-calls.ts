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
