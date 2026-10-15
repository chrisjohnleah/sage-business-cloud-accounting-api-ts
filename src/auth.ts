import { SageAuthError, SageNotConnectedError } from './errors.js'
import { requestToken, type OAuthClient } from './oauth.js'
import type { StoredToken, TokenStore } from './token-store.js'

/**
 * Keeps the access token fresh. Sage's refresh tokens are single use, so two
 * refreshes from the same token cannot both work. This class makes sure that
 * inside one process only one refresh runs at a time, that a refresh which lost
 * the race to another process uses the winner's token, and that it never
 * forgets a stored token on its own.
 */
export class TokenManager {
  #inflight: Promise<StoredToken> | null = null

  constructor(
    private readonly client: OAuthClient,
    private readonly store: TokenStore,
    private readonly bufferMs: number,
  ) {}

  /**
   * The stored token, refreshed first when it expires within the buffer.
   * Pass `rejected` (the access token Sage just answered 401 to) to force a
   * refresh, unless someone else has already replaced that token.
   */
  async get(rejected?: string): Promise<StoredToken> {
    const current = await this.#read()
    if (this.#usable(current, rejected)) return current
    return this.#refresh(rejected)
  }

  async #read(): Promise<StoredToken> {
    const current = await this.store.get()
    if (!current) throw new SageNotConnectedError('No Sage connection is stored. Send a person through authorizationUrl() first.')
    return current
  }

  #usable(token: StoredToken, rejected?: string): boolean {
    return token.expiresAt - Date.now() > this.bufferMs && token.accessToken !== rejected
  }

  #refresh(rejected?: string): Promise<StoredToken> {
    this.#inflight ??= this.#run(0, rejected).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  async #run(depth: number, rejected?: string): Promise<StoredToken> {
    // Read again here: the caller's copy may be older than a refresh that has just finished,
    // and a refresh token Sage has already consumed must not be sent a second time.
    const current = await this.#read()
    if (this.#usable(current, rejected)) return current
    let response
    try {
      response = await requestToken(this.client, { grant_type: 'refresh_token', refresh_token: current.refreshToken })
    } catch (error) {
      if (error instanceof SageAuthError && error.code === 'invalid_grant') return this.#recover(current, depth, rejected)
      throw error
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Sage has rotated the refresh token, so what we got must be stored or the connection is lost.
      // Read the store again for everything else: selectBusiness may have changed businessId while the request was out.
      const latest = await this.store.get()
      if (!latest) throw new SageNotConnectedError('The connection was removed while its token was being refreshed. A person needs to connect again.')
      // Another process stored a newer token first: use it rather than overwrite it.
      if (latest.refreshToken !== current.refreshToken && this.#usable(latest, rejected)) return latest
      const next: StoredToken = {
        ...response,
        businessId: latest.businessId,
        ...(response.scope === undefined && latest.scope !== undefined ? { scope: latest.scope } : {}),
      }
      if ((await this.store.put(next, latest)) !== false) return next
    }
    throw new SageNotConnectedError('The refreshed token could not be saved because the stored token kept changing. A person needs to connect again.')
  }

  /** Sage said invalid_grant: either another process already used this refresh token, or the connection is gone. */
  async #recover(used: StoredToken, depth: number, rejected?: string): Promise<StoredToken> {
    const latest = await this.store.get()
    if (latest && latest.refreshToken !== used.refreshToken && depth === 0) {
      return this.#usable(latest, rejected) ? latest : this.#run(1, rejected)
    }
    throw new SageNotConnectedError(
      'Sage rejected the stored refresh token (it expired after 31 days unused, was revoked, or was already used). A person needs to connect again.',
    )
  }
}
