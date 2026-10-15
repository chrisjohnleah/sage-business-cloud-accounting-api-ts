import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'

// The strictest proof that the package needs nothing from Node: bundle it with
// no Node shims and run it in workerd with no compatibility flags. Any node:
// import, Buffer or process would stop the worker from loading or running.
it('loads and works in workerd without nodejs_compat', async () => {
  const entry = fileURLToPath(new URL('./workers/bare-worker.ts', import.meta.url))
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'], conditions: ['import'] })
  const script = bundle.outputFiles[0]!.text
  expect(script).not.toMatch(/from\s*["']node:/)

  const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-08-01', compatibilityFlags: [] })
  try {
    const response = await mf.dispatchFetch('http://worker.test/')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ids: ['1', '2'],
      firstPage: 1,
      pence: 100,
      seen: [
        'POST /token -',
        'GET /v3.1/contacts Bearer a1',
        'GET /v3.1/contacts?page=2 Bearer a1',
        'GET /v3.1/contacts Bearer a1',
      ],
    })
  } finally {
    await mf.dispose()
  }
}, 60_000)
