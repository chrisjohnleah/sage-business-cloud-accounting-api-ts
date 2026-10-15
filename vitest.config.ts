import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const alias = {
  'sage-business-cloud-accounting-api': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'node', include: ['test/*.test.ts'] },
      },
      {
        // The same code inside workerd, which has no Node built-ins.
        resolve: { alias },
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-10-01',
              d1Databases: ['DB'],
            },
          }),
        ],
        test: { name: 'workers', include: ['test/workers/*.test.ts'] },
      },
    ],
  },
})
