import { SageAuthError } from './errors.js'
import { anySignal } from './util.js'

export const AUTHORIZE_URL = 'https://www.sageone.com/oauth2/auth/central'
export const TOKEN_URL = 'https://oauth.accounting.sage.com/token'
export const REVOKE_URL = 'https://oauth.accounting.sage.com/revoke'

export type Fetcher = (request: Request) => Promise<Response>

export interface OAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
  fetch: Fetcher
  timeoutMs: number
  userAgent: string
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
}

export function authorizationUrl(client: OAuthClient, params: { scope: string; country: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', client.redirectUri)
  url.searchParams.set('scope', params.scope)
  url.searchParams.set('state', params.state)
  url.searchParams.set('filter', 'apiv3.1')
  url.searchParams.set('country', params.country)
  return url.toString()
}

async function postForm(client: OAuthClient, url: string, form: Record<string, string>, signal?: AbortSignal) {
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': client.userAgent,
    },
    // Sage documents client_id and client_secret in the body, not in a Basic header.
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...form }),
    signal: anySignal([AbortSignal.timeout(client.timeoutMs), ...(signal ? [signal] : [])]),
  })
  const response = await client.fetch(request)
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
  } catch {
    // not JSON; handled below
  }
  if (!response.ok) {
    const code = typeof json?.error === 'string' ? json.error : `http_${response.status}`
    const description = typeof json?.error_description === 'string' ? json.error_description : null
    throw new SageAuthError(code, description, response.status)
  }
  return json
}

/** Calls Sage's token endpoint. Throws `SageAuthError` when Sage refuses or answers with something unexpected. */
export async function requestToken(
  client: OAuthClient,
  grant: { grant_type: 'authorization_code'; code: string; redirect_uri: string } | { grant_type: 'refresh_token'; refresh_token: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const json = await postForm(client, TOKEN_URL, grant, signal)
  const expiresIn = Number(json?.expires_in)
  if (typeof json?.access_token !== 'string' || typeof json.refresh_token !== 'string' || !Number.isFinite(expiresIn)) {
    throw new SageAuthError('invalid_response', 'The token endpoint reply did not contain the expected fields.')
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
  }
}

/** Tells Sage to stop honouring a refresh token. */
export async function revokeToken(client: OAuthClient, refreshToken: string): Promise<void> {
  await postForm(client, REVOKE_URL, { token: refreshToken })
}
