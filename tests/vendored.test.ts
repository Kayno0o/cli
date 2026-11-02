import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const MODS = join(homedir(), 'zshrc/dotfiles/claude/mods')

// The Claude Code mods carry copies of these sources, a first comment line naming the original.
const COPIES = [
  ['packages/git/src/status.ts', 'git-facts/hooks/status.ts'],
  ['packages/kit/src/shell.ts', 'guards/hooks/shell.ts'],
  ['packages/guard/src/bins.ts', 'agent-tools/hooks/bins.ts'],
] as const

describe('the mods\' copies', () => {
  for (const [source, copy] of COPIES) {
    // Only where the mods live, ~/zshrc, so CI skips it.
    const present = existsSync(join(MODS, copy))

    test.skipIf(!present)(`${copy} matches ${source}`, async () => {
      const copied = await Bun.file(join(MODS, copy)).text()

      expect(copied.slice(copied.indexOf('\n') + 1)).toBe(await Bun.file(join(ROOT, source)).text())
    })
  }
})
