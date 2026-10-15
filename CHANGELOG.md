# Changelog

All notable changes to this package are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

First release.

### Added
- `createSage` with typed access to all of Sage Business Cloud Accounting API v3.1 through `sage.api` (openapi-fetch over types generated from Sage's own spec).
- OAuth: `authorizationUrl`, `handleCallback` (state check, `?error=` handling, code exchange), `disconnect` with optional revoke.
- `TokenStore` contract with compare and swap, and `MemoryTokenStore`.
- Lazy token refresh with single flight inside a process, compare and swap across processes, and recovery from `invalid_grant` when another process already refreshed.
- `listBusinesses`, `selectBusiness` and `X-Business` on every API call. A business chosen during a refresh is kept, and a reconnect keeps the business only if the new login can reach it.
- `paginate` over `$next`, which refuses a `$next` on another origin and one that loops.
- Retries: 429 with `Retry-After` or exponential backoff and jitter; 5xx, network errors and timeouts only for GET, HEAD, PUT and DELETE (a POST is never repeated, even with an `idempotency_id`); a single refresh and repeat after a 401; a timeout per attempt.
- `SageApiError`, `SageAuthError`, `SageNotConnectedError`, `SagePaginationError`, and `assertOk`.
- `toPence` (Sage amount to integer pence) and `newIdempotencyId`.
- `scripts/patch-spec.mjs`, which corrects Sage's spec before the types are generated: list envelopes, missing response schemas, an error schema, money fields as `number | string`, and `idempotency_id` (from Sage's idempotency guide) on the request bodies that accept it.
