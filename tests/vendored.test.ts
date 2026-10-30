import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const MODS = join(homedir(), 'zshrc/dotfiles/claude/mods')

// The Claude Code mods carry copies of these sources, a first comment line naming the original.
const COPIES = [
  ['packages/out/src/wrap.ts', 'agent-tools/hooks/wrap.ts'],
  ['packages/db/src/guard.ts', 'guards/hooks/sql-guard.ts'],
  ['packages/git/src/status.ts', 'git-facts/hooks/status.ts'],
] as const

// Only where the mods live, ~/zshrc, so CI skips it.
const present = await Bun.file(join(MODS, COPIES[0][1])).exists()

describe.skipIf(!present)('the mods\' copies', () => {
  for (const [source, copy] of COPIES) {
    test(`${copy} matches ${source}`, async () => {
      const copied = await Bun.file(join(MODS, copy)).text()

      expect(copied.slice(copied.indexOf('\n') + 1)).toBe(await Bun.file(join(ROOT, source)).text())
    })
  }
})
