/** One entry of the error list Sage sends with a failed API call. */
export interface SageErrorDetail {
  $severity?: string
  $dataCode?: string
  $message?: string
  $source?: string
}

/** Pulls Sage's error entries out of a parsed body, which is an array or a single object. */
function parseDetails(body: unknown): SageErrorDetail[] {
  const entries = Array.isArray(body) ? body : [body]
  return entries.filter(
    (entry): entry is SageErrorDetail => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
}

/** An API call that Sage answered with an error status. Never carries the token. */
export class SageApiError extends Error {
  override name = 'SageApiError'
  readonly status: number
  /** Sage's error entries; empty when the body was not JSON in Sage's format. */
  readonly errors: SageErrorDetail[]
  readonly method: string
  /** Path below the base URL, without the query string, for example `/sales_invoices`. */
  readonly path: string
  /** The parsed body, or the first 500 characters of it when it was not JSON. */
  readonly body: unknown
  /** Sage's `x_request_id` response header. Quote it when you contact Sage support. */
  readonly requestId: string | null

  constructor(init: { status: number; body: unknown; method: string; path: string; requestId?: string | null }) {
    const errors = parseDetails(init.body)
    const text = errors.map((e) => e.$message).filter(Boolean).join('; ')
    super(`Sage API error (HTTP ${init.status}) on ${init.method} ${init.path}${text ? `: ${text}` : ''}`)
    this.status = init.status
    this.errors = errors
    this.method = init.method
    this.path = init.path
    this.body = typeof init.body === 'string' ? init.body.slice(0, 500) : init.body
    this.requestId = init.requestId ?? null
  }
}

/** The OAuth steps failed: Sage's token endpoint refused, the callback carried an error, or the state was wrong. */
export class SageAuthError extends Error {
  override name = 'SageAuthError'
  /** OAuth error code, for example `invalid_grant`, `access_denied` or `state_mismatch`. */
  readonly code: string
  readonly description: string | null
  readonly status: number | null

  constructor(code: string, description?: string | null, status?: number | null) {
    super(`Sage authorisation failed: ${code}${description ? ` (${description})` : ''}`)
    this.code = code
    this.description = description ?? null
    this.status = status ?? null
  }
}

/** There is no usable connection to Sage, so a person has to connect again. */
export class SageNotConnectedError extends Error {
  override name = 'SageNotConnectedError'
}

/** Pagination was stopped because following it would be unsafe or endless. */
export class SagePaginationError extends Error {
  override name = 'SagePaginationError'
}
