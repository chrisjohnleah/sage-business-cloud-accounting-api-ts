# Security policy

## Supported versions

Security fixes go into the latest release.

## Reporting a vulnerability

Please do not report a vulnerability in a public issue. Report it privately through GitHub instead: open the repository's Security tab and choose "Report a vulnerability" (https://github.com/chrisjohnleah/sage-business-cloud-accounting-api-ts/security/advisories/new). Say what you found, how to reproduce it, and what you think the impact is. You will get an acknowledgement as soon as possible and a plan once the report has been looked at. Please allow a reasonable time to fix the problem before you tell anyone else.

## What this package does with secrets

- The client secret, access token and refresh token are held in memory and in the `TokenStore` you provide. Where that store keeps them (a database, a file) is your responsibility: keep it private, and encrypt it at rest if your platform allows.
- The access token is sent only in the `Authorization` header of requests to the base URL, and the client secret only in the body of requests to Sage's token and revoke endpoints.
- A `$next` link that leaves the base URL's origin is never followed, so the bearer token cannot be sent elsewhere.
- Tokens, authorisation codes, the client secret and the OAuth `state` are never written to a log and never put in an error message or error property that this package builds. Text that Sage itself sends back in an error body is kept as sent. The package does not log at all.
- The OAuth `state` is made from 32 random bytes and compared in constant time.
- The package has one runtime dependency, `openapi-fetch`, and no install scripts.

Things to watch in the areas this package touches: token storage, the OAuth flow, and the handling of the `X-Business` header.
