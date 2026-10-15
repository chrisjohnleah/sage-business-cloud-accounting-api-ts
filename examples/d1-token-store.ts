import type { StoredToken, TokenStore } from 'sage-business-cloud-accounting-api'

/** The slice of Cloudflare's D1 binding this store needs. The real `D1Database` fits. */
export interface D1Like {
  prepare(sql: string): D1Statement
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
}

/** Run this once, for example in a D1 migration. One connection, so one row. */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS sage_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  business_id TEXT,
  scope TEXT
)`

interface Row {
  access_token: string
  refresh_token: string
  expires_at: number
  business_id: string | null
  scope: string | null
}

export class D1TokenStore implements TokenStore {
  constructor(private readonly db: D1Like) {}

  async get(): Promise<StoredToken | null> {
    const row = await this.db
      .prepare('SELECT access_token, refresh_token, expires_at, business_id, scope FROM sage_token WHERE id = 1')
      .first<Row>()
    if (!row) return null
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      businessId: row.business_id,
      ...(row.scope ? { scope: row.scope } : {}),
    }
  }

  /** Compare and swap: the row only changes if it still holds the refresh token and business we started from. */
  async put(next: StoredToken, previous: StoredToken | null): Promise<boolean> {
    const values = [next.accessToken, next.refreshToken, next.expiresAt, next.businessId, next.scope ?? null]
    const result = previous
      ? await this.db
          .prepare(
            'UPDATE sage_token SET access_token = ?, refresh_token = ?, expires_at = ?, business_id = ?, scope = ? WHERE id = 1 AND refresh_token = ? AND business_id IS ?',
          )
          .bind(...values, previous.refreshToken, previous.businessId)
          .run()
      : await this.db
          .prepare(
            'INSERT INTO sage_token (id, access_token, refresh_token, expires_at, business_id, scope) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
          )
          .bind(...values)
          .run()
    return result.meta.changes === 1
  }

  async forget(): Promise<void> {
    await this.db.prepare('DELETE FROM sage_token WHERE id = 1').run()
  }
}
