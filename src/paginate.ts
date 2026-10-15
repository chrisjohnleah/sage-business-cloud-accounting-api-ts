import { SagePaginationError } from './errors.js'

/**
 * Turns Sage's `$next` into the URL to fetch. Sage's own docs show a path
 * (`/contacts?page=2`) relative to the base URL; other clients have seen the
 * full URL. Anything that would leave the base URL's origin is refused, because
 * the bearer token goes with every request.
 */
export function resolveNext(next: string, baseUrl: string): URL {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/$/, '')
  let url: URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(next) || next.startsWith('//')) {
    url = new URL(next, base)
  } else {
    const path = next.startsWith('/') ? next : `/${next}`
    url = new URL(path.startsWith(`${basePath}/`) ? path : `${basePath}${path}`, base.origin)
  }
  if (url.origin !== base.origin) {
    throw new SagePaginationError(`Refusing to follow $next to ${url.origin}: it is not ${base.origin}.`)
  }
  return url
}
