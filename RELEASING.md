# Releasing

1. Update `version` in `package.json` and `VERSION` in `src/version.ts` (a test checks they agree), and add a dated section to `CHANGELOG.md`.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:generated`, and `npm pack --dry-run`. The pack list must hold only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`.
3. Commit, then tag: `git tag v0.1.0 && git push origin main v0.1.0`.

## First publish

npm only lets you set up trusted publishing for a package that already exists. So the very first publish is done by hand, from the author's npm account:

```sh
npm login
npm publish --access public
```

Then, on npmjs.com, open the package settings, add a trusted publisher (GitHub Actions, repository `chrisjohnleah/sage-business-cloud-accounting-api-ts`, workflow `release.yml`).

## Every release after that

Pushing a `v*` tag runs `.github/workflows/release.yml`, which tests, builds and publishes with provenance through GitHub OIDC. There is no npm token in the repository or in GitHub secrets. Check that the tag matches `package.json` first; the workflow refuses a mismatch.
