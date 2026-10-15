// Writes openapi/sage-accounting-3.1.0.patched.json from Sage's own spec.
//
// Sage's OpenAPI file is the source of truth for every path, parameter and
// request body. It is wrong about a handful of things the real API does, and
// each fix below says why. Nothing else is changed.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(root, 'openapi/sage-accounting-3.1.0.json')
const DEFAULT_OUT = resolve(root, 'openapi/sage-accounting-3.1.0.patched.json')

const JSON_TYPE = 'application/json'
const METHODS = ['get', 'put', 'post', 'delete', 'patch']

// Resources that accept `idempotency_id` inside their own namespace, copied from
// Sage's "Idempotency" guide, read on 14 Oct 2026:
// https://developer.sage.com/accounting/docs/v1.0.0/guides/learning/key-concepts/idempotency
// The spec does not list the field at all (it only has X-Idempotency-Key on two tax return POSTs).
const IDEMPOTENT = new Set([
  'address', 'bank_account', 'bank_deposit', 'bank_opening_balance', 'bank_reconciliation',
  'bank_transfer', 'business_exchange_rate', 'contact', 'contact_allocation',
  'contact_opening_balance', 'contact_payment', 'contact_person',
  'hosted_artefact_payment_setting', 'journal', 'journal_code', 'ledger_account',
  'ledger_account_opening_balance', 'migration_tax_return', 'opening_balance_journal',
  'other_payment', 'product', 'product_sales_price_type', 'purchase_credit_note',
  'purchase_invoice', 'purchase_quick_entry', 'sales_credit_note', 'sales_estimate',
  'sales_invoice', 'sales_quick_entry', 'sales_quote', 'service', 'service_rate_type',
  'stock_item', 'stock_movement', 'tax_profile',
])

// Names of response number fields that hold money, by what the spec calls them. Checked against
// every number field in the spec: rates, percentages and quantities are excluded first.
export const isMoney = (name) =>
  !/(rate|percentage|quantity)/.test(name) && /(amount|price|balance|debit|credit|total|net|tax|discount|profit|cost|value|capital|charge|^box_)/.test(name)

const pascal = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')
const singular = (s) =>
  s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('sses') || s.endsWith('xes') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s

export function patchSpec(spec) {
  const schemas = spec.components.schemas
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
  const jsonSchema = (resp) => resp?.content?.[JSON_TYPE]?.schema
  const example = (resp) => {
    const ex = resp?.content?.[JSON_TYPE]?.examples
    return ex ? Object.values(ex)[0]?.value : undefined
  }

  // 1. Every list endpoint returns an envelope, not a bare array. The spec
  //    declares an array (or nothing). Real replies, and the examples in the
  //    spec itself, look like { $total, $page, $next, $back, $itemsPerPage, $items }.
  //    The examples spell the page size both `$itemsPerPage` and `$items_per_page`.
  const listFor = (itemSchema, name) => {
    const listName = `${name}List`
    schemas[listName] ??= {
      type: 'object',
      description: 'Paginated envelope that Sage wraps around every list response (added by scripts/patch-spec.mjs).',
      properties: {
        $total: { type: 'integer' },
        $page: { type: 'integer' },
        $next: { type: 'string', nullable: true, description: 'Path or URL of the next page, null on the last page.' },
        $back: { type: 'string', nullable: true },
        $itemsPerPage: { type: 'integer' },
        $items_per_page: { type: 'integer', description: 'Spelled this way in a few of Sage\'s own examples.' },
        $items: { type: 'array', items: itemSchema },
      },
      required: ['$items'],
    }
    return ref(listName)
  }

  // 2. GETs the spec gives no schema (only an example) get the matching
  //    component schema where one exists, so `data` is typed instead of unknown.
  const matchingSchema = (path) => {
    const last = path.split('/').filter((p) => p && !p.startsWith('{')).pop()
    return [pascal(last), pascal(singular(last))].find((n) => schemas[n])
  }

  for (const [path, item] of Object.entries(spec.paths)) {
    const get = item.get
    const ok = get?.responses?.['200']
    if (ok) {
      const body = ok.content?.[JSON_TYPE]
      const schema = body?.schema
      if (schema?.type === 'array') {
        body.schema = listFor(schema.items, schema.items.$ref.split('/').pop())
      } else if (!schema && body) {
        const name = matchingSchema(path)
        if (name) {
          const isList = example(ok)?.$items !== undefined
          body.schema = isList ? listFor(ref(name), name) : ref(name)
        }
      }
    }
  }

  // 3. The spec has no error schema at all. Sage replies to a 4xx with either an
  //    array of these or a single one (Sage's "Response Codes" guide shows both).
  schemas.SageError = {
    type: 'object',
    properties: {
      $severity: { type: 'string', description: 'Usually "error".' },
      $dataCode: { type: 'string', description: 'Machine readable code, for example "AccessTokenExpiredError".' },
      $message: { type: 'string' },
      $source: { type: 'string', description: 'The field the error is about, or the part of Sage that raised it.' },
    },
  }
  const errorResponse = {
    description: 'Client error. Sage sends an array of errors or a single error (added by scripts/patch-spec.mjs).',
    content: { [JSON_TYPE]: { schema: { oneOf: [{ type: 'array', items: ref('SageError') }, ref('SageError')] } } },
  }
  for (const item of Object.values(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method]
      if (op?.responses && !op.responses['4XX']) op.responses['4XX'] = errorResponse
    }
  }

  // 4. Money arrives as a number or as a numeric string ("120.00"). The spec says number.
  //    Response money fields now say number | string so code that adds them up has to look
  //    first (see toPence). Only money is loosened: quantities, rates, percentages and
  //    weights stay numbers. Request bodies are left alone.
  const loosen = (node) => {
    if (Array.isArray(node)) return node.forEach(loosen)
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && value.type === 'number' && isMoney(key)) {
        const { type: _t, format: _f, ...rest } = value
        node[key] = { ...rest, oneOf: [{ type: 'number' }, { type: 'string' }] }
      } else loosen(value)
    }
  }
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/^(post|put)[A-Z]/.test(name)) loosen(schema)
  }

  // 5. `idempotency_id` is documented by Sage (URL at the top) but missing from the spec.
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/^(post|put)[A-Z]/.test(name)) continue
    for (const [ns, inner] of Object.entries(schema.properties ?? {})) {
      if (IDEMPOTENT.has(ns) && inner.properties) {
        inner.properties.idempotency_id = {
          type: 'string',
          description: 'A random 32 character hyphenless id made by the client. Repeating the same request with it within 7 days returns the first result instead of creating a second record.',
        }
      }
    }
  }

  return spec
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT
  const patched = patchSpec(JSON.parse(readFileSync(SOURCE, 'utf8')))
  writeFileSync(out, JSON.stringify(patched, null, 1) + '\n')
  console.log(`wrote ${out}`)
}
