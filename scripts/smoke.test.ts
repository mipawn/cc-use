import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('repository smoke harness', () => {
  it('serves the renderer entrypoint from the root HTML shell', () => {
    const rootDir = resolve(import.meta.dirname, '..')
    const html = readFileSync(resolve(rootDir, 'index.html'), 'utf8')

    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('src="/src/renderer/main.tsx"')
  })
})
