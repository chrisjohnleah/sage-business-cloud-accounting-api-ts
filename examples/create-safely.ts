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
