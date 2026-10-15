import type { Sage } from 'sage-business-cloud-accounting-api'

/** Every invoice changed since a date, 200 at a time. */
export async function changedInvoices(sage: Sage, since: string) {
  const invoices = []
  for await (const invoice of sage.paginate('/sales_invoices', { params: { query: { updated_or_created_since: since, items_per_page: 200 } } })) {
    invoices.push(invoice)
  }
  return invoices
}
