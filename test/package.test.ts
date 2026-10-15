import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json')) as Record<string, any>

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : [path]
  })
}

describe('package', () => {
  it('reports the version in package.json in its User-Agent', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('is ESM only with one runtime dependency', () => {
    expect(pkg.type).toBe('module')
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.engines).toEqual({ node: '>=20' })
    expect(Object.keys(pkg.dependencies)).toEqual(['openapi-fetch'])
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' })
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md'])
  })

  it('pins every dev dependency exactly', () => {
    for (const [name, range] of Object.entries(pkg.devDependencies as Record<string, string>)) {
      expect(range, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
    }
  })
})

describe('src needs nothing from Node', () => {
  it('never mentions node: imports, Buffer or process.', () => {
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(read(file.slice(root.length)), file).not.toMatch(/node:|\bBuffer\b|\bprocess\./)
    }
  })
})

describe('docs', () => {
  const docs = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'RELEASING.md']

  it('use no em or en dashes', () => {
    for (const file of docs) expect(read(file), file).not.toMatch(/[–—]/)
  })

  it('print the example files in full wherever the README names them', () => {
    const readme = read('README.md')
    const blocks = [...readme.matchAll(/```ts\n\/\/ (examples\/[\w-]+\.ts)\n([\s\S]*?)```/g)]
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    for (const [, file, code] of blocks) expect(read(file!).trimEnd(), file).toBe(code!.trimEnd())
  })

  it('has no README code block that is not either a type checked example or a plain type declaration', () => {
    const untagged = [...read('README.md').matchAll(/```ts\n(?!\/\/ examples\/)([\s\S]*?)```/g)].map((m) => m[1]!)
    for (const code of untagged) {
      expect(code, code).not.toMatch(/\/\*|\.\.\./)
      expect(code, code).toMatch(/^(import type |interface |type )/)
    }
  })
})
