// Fails when src/generated/sage.ts is not what `npm run generate` would write now.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'sage-generated-'))
try {
  const patched = join(temp, 'patched.json')
  const generated = join(temp, 'sage.ts')
  execFileSync(process.execPath, [join(root, 'scripts/patch-spec.mjs'), patched], { stdio: 'ignore' })
  execFileSync(process.execPath, [join(root, 'node_modules/openapi-typescript/bin/cli.js'), patched, '-o', generated], { stdio: 'ignore' })
  if (readFileSync(generated, 'utf8') !== readFileSync(join(root, 'src/generated/sage.ts'), 'utf8')) {
    console.error('src/generated/sage.ts is out of date. Run `npm run generate` and commit the result.')
    process.exit(1)
  }
  console.log('src/generated/sage.ts is up to date.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
