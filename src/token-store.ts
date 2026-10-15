export interface StoredToken {
  accessToken: string
  refreshToken: string
  /** When the access token stops working, in epoch milliseconds. */
  expiresAt: number
  /** The business sent as `X-Business` on every API call, or null for Sage's lead business. */
  businessId: string | null
  scope?: string
}

/**
 * Where the one connection to Sage is kept. Sage rotates the refresh token on
 * every refresh, so `put` must replace the previous record.
 */
export interface TokenStore {
  get(): StoredToken | null | Promise<StoredToken | null>
  /**
   * Save `next` only if the stored token is still `previous` (compare and swap):
   * the same refresh token and, if you can, the same `businessId`, so a business
   * chosen while a refresh was in flight is not overwritten. Return `false` when
   * it is not. Returning nothing counts as success.
   */
  put(next: StoredToken, previous: StoredToken | null): boolean | void | Promise<boolean | void>
  forget(): void | Promise<void>
}

/** Keeps the token in memory. Fine for scripts and tests, not for anything that restarts or runs in several places. */
export class MemoryTokenStore implements TokenStore {
  #token: StoredToken | null

  constructor(initial: StoredToken | null = null) {
    this.#token = initial ? { ...initial } : null
  }

  get(): StoredToken | null {
    return this.#token ? { ...this.#token } : null
  }

  put(next: StoredToken, previous: StoredToken | null): boolean {
    if ((this.#token?.refreshToken ?? null) !== (previous?.refreshToken ?? null)) return false
    if (this.#token && this.#token.businessId !== previous?.businessId) return false
    this.#token = { ...next }
    return true
  }

  forget(): void {
    this.#token = null
  }
}
