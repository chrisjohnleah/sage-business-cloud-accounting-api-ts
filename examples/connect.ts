import type { Sage } from 'sage-business-cloud-accounting-api'

/** Step one: send the person to `url`, and keep `state` somewhere that survives the round trip (a cookie, a session, a database row). */
export function startConnect(sage: Sage) {
  return sage.authorizationUrl()
}

/** Step two: `callbackUrl` is the full address Sage sent the person back to. */
export async function finishConnect(sage: Sage, callbackUrl: string, state: string) {
  await sage.handleCallback(callbackUrl, state)
}
