# Contributing

Issues and pull requests are welcome.

```sh
npm ci
npm run typecheck   # tsc over src, tests and examples
npm test            # vitest: Node tests, tests in workerd, and a bare workerd run with no Node compatibility
npm run build       # tsc to dist
```

No test may reach Sage. Every test uses the fake fetch in `test/helpers/fake-fetch.ts`. Never put a real token, client id or secret in the repository.

## Changing the types

The types in `src/generated/sage.ts` come from Sage's spec in `openapi/sage-accounting-3.1.0.json` (Sage's file, do not edit it by hand) after `scripts/patch-spec.mjs` corrects what the spec gets wrong. To change a fix, edit the script, then:

```sh
npm run generate        # writes the patched spec and src/generated/sage.ts
npm run check:generated # what CI runs: fails if the committed file is stale
```

Commit `src/generated/sage.ts` with the change. To move to a newer spec, replace the vendored JSON, run `npm run generate` and read the diff.

## Style

British English in the docs, no em or en dashes in published copy (a test checks), small plain code, and a test for each piece of real logic. The README prints the three files in `examples/` in full, and a test keeps the two in step.
