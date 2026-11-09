import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const MODS = join(homedir(), 'zshrc/dotfiles/claude/mods')
const IMPORT = /^(?:import|export)\b[^'"\n]*?from '([^']+)'/gm

// The Claude Code mods carry copies of these sources, a first comment line naming the original; the manifest holds each source's sha256 as of the last sync.
const manifest = await Bun.file(join(ROOT, 'tests/vendored.json')).json() as Record<string, { copy: string, sha256: string }>

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

describe('the mods\' copies', () => {
  for (const [source, { copy, sha256: synced }] of Object.entries(manifest)) {
    // The manifest is what CI checks: a source changing without a sync fails anywhere.
    test(`${source} is as last synced to the mods`, async () => {
      const actual = sha256(await Bun.file(join(ROOT, source)).text())

      if (actual !== synced)
        throw new Error(`${source} changed since it was copied to ${copy}: sync that copy in ~/zshrc/dotfiles/claude/mods, then set its sha256 in tests/vendored.json to ${actual}`)
    })

    // A mod's hooks module may import only its own files and 'claude-code', so a node: or package import fails to load there.
    test(`${source} imports nothing a mod cannot`, async () => {
      const imports = [...(await Bun.file(join(ROOT, source)).text()).matchAll(IMPORT)].map(match => match[1] ?? '')

      expect(imports.filter(specifier => !specifier.startsWith('.') && specifier !== 'claude-code')).toEqual([])
    })

    // Only where the mods live, ~/zshrc, are the copies themselves compared.
    test.skipIf(!existsSync(join(MODS, copy)))(`${copy} matches ${source}`, async () => {
      const copied = await Bun.file(join(MODS, copy)).text()
      const body = copied.slice(copied.indexOf('\n') + 1)

      expect(body).toBe(await Bun.file(join(ROOT, source)).text())
      expect(sha256(body)).toBe(synced)
    })
  }
})
