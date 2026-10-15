import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript script without types
import { patchSpec } from '../scripts/patch-spec.mjs'

type Spec = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } }
const original = JSON.parse(readFileSync(new URL('../openapi/sage-accounting-3.1.0.json', import.meta.url), 'utf8')) as Spec
const patched = patchSpec(structuredClone(original)) as Spec

describe('scripts/patch-spec.mjs', () => {
  it('wraps every list GET in the pagination envelope', () => {
    let wrapped = 0
    for (const [path, item] of Object.entries(patched.paths)) {
      const schema = item.get?.responses?.['200']?.content?.['application/json']?.schema
      expect(schema?.type, path).not.toBe('array')
      if (schema?.$ref?.endsWith('List')) wrapped++
    }
    expect(wrapped).toBeGreaterThan(50)
    expect(patched.components.schemas.SalesInvoiceList.properties.$items.items.$ref).toBe('#/components/schemas/SalesInvoice')
    expect(patched.components.schemas.SalesInvoiceList.required).toEqual(['$items'])
    expect(Object.keys(patched.components.schemas.SalesInvoiceList.properties)).toEqual(
      expect.arrayContaining(['$total', '$page', '$next', '$back', '$itemsPerPage', '$items_per_page', '$items']),
    )
  })

  it('points the schema-less GETs at their component', () => {
    const ref = (path: string) => patched.paths[path]!.get.responses['200'].content['application/json'].schema.$ref
    expect(ref('/businesses')).toBe('#/components/schemas/BusinessList')
    expect(ref('/contacts')).toBe('#/components/schemas/ContactList')
    expect(ref('/contacts/{key}')).toBe('#/components/schemas/Contact')
    expect(ref('/contact_payments')).toBe('#/components/schemas/ContactPaymentList')
  })

  it('adds an error schema to every operation', () => {
    expect(Object.keys(patched.components.schemas.SageError.properties)).toEqual(['$severity', '$dataCode', '$message', '$source'])
    for (const [path, item] of Object.entries(patched.paths)) {
      for (const method of ['get', 'put', 'post', 'delete']) {
        if (item[method]) expect(item[method].responses['4XX'], `${method} ${path}`).toBeDefined()
      }
    }
  })

  it('lets response money be a number or a string, and leaves request bodies alone', () => {
    expect(patched.components.schemas.SalesInvoice.properties.total_amount.oneOf).toEqual([{ type: 'number' }, { type: 'string' }])
    expect(patched.components.schemas.postSalesInvoices.properties.sales_invoice.properties.cis_applicable_amount.type).toBe('number')
  })

  it('loosens money only: quantities, rates, percentages and weights stay numbers', () => {
    const loosened = new Set<string>()
    const kept = new Set<string>()
    const walk = (node: any, key = '') => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, key))
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node.oneOf) && node.oneOf.length === 2 && node.oneOf[0]?.type === 'number' && node.oneOf[1]?.type === 'string') loosened.add(key)
      else if (node.type === 'number') kept.add(key)
      for (const [k, v] of Object.entries(node)) walk(v, k)
    }
    for (const [name, schema] of Object.entries(patched.components.schemas)) if (!/^(post|put)[A-Z]/.test(name)) walk(schema)
    expect(loosened.size).toBeGreaterThan(60)
    for (const key of loosened) expect(key, key).not.toMatch(/quantity|rate|percentage|weight|reorder/)
    expect([...kept]).toEqual(expect.arrayContaining(['quantity', 'exchange_rate', 'weight', 'reorder_level', 'discount_percentage']))
    expect([...loosened]).toEqual(expect.arrayContaining(['total_amount', 'outstanding_amount', 'unit_price', 'balance', 'credit_limit']))
  })

  it('documents idempotency_id on the resources that support it, and only those', () => {
    expect(patched.components.schemas.postSalesInvoices.properties.sales_invoice.properties.idempotency_id.type).toBe('string')
    expect(patched.components.schemas.putContacts.properties.contact.properties.idempotency_id).toBeDefined()
    expect(patched.components.schemas.putBusinessSettings.properties.business_settings.properties.idempotency_id).toBeUndefined()
  })

  it('leaves the vendored spec untouched', () => {
    expect(original.paths['/sales_invoices']!.get.responses['200'].content['application/json'].schema.type).toBe('array')
  })
})
