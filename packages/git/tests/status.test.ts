import { describe, expect, test } from 'bun:test'
import { parseStatus, summary, unquote } from '../src/status'

const STATUS = `# branch.oid 6e26055a392d9734b51f4b866fe130a901b26b31
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 856f 856f dotfiles/config/kdeglobals
1 M. N... 100644 100644 100644 856f 856f dotfiles/with space.txt
2 R. N... 100644 100644 100644 856f 856f R100 new name.ts\told name.ts
u UU N... 100644 100644 100644 100644 856f 856f 856f clash.ts
? notes.md
`

describe('parseStatus', () => {
  test('reads the branch, the changes by side, renames, conflicts and untracked paths', () => {
    expect(parseStatus(STATUS)).toEqual({
      branch: 'main',
      oid: '6e26055a392d9734b51f4b866fe130a901b26b31',
      upstream: 'origin/main',
      aheadBehind: { ahead: 2, behind: 1 },
      changes: [
        { path: 'dotfiles/config/kdeglobals', index: '.', worktree: 'M' },
        { path: 'dotfiles/with space.txt', index: 'M', worktree: '.' },
        { path: 'new name.ts', from: 'old name.ts', index: 'R', worktree: '.' },
      ],
      conflicted: ['clash.ts'],
      untracked: ['notes.md'],
    })
  })

  test('is null without a branch header', () => {
    expect(parseStatus('')).toBeNull()
  })
})

describe('summary', () => {
  test('branch, upstream, files and HEAD in one line', () => {
    const status = parseStatus(STATUS.replace(/^[12u] .*\n/gm, '').concat('1 .M N... 100644 100644 100644 856f 856f a\n'))

    expect(status === null ? '' : summary(status, '6e26055\0feat(fish): keep scratchpads on disk\n')).toBe('branch `main`, 2 ahead and 1 behind `origin/main` as of the last fetch; 1 changed, 1 untracked files; HEAD 6e26055 feat(fish): keep scratchpads on disk')
  })

  test('a detached HEAD, no upstream, a gone upstream or no commit yet', () => {
    const line = (text: string, head: string) => {
      const status = parseStatus(text)

      return status === null ? '' : summary(status, head)
    }

    expect(line('# branch.oid abcdef1234\n# branch.head (detached)\n', 'abcdef1\0x')).toBe('detached at abcdef1, no upstream; 0 changed files; HEAD abcdef1 x')
    expect(line('# branch.oid (initial)\n# branch.head main\n', '')).toContain('; no commit yet')
    expect(line('# branch.oid abcdef1234\n# branch.head fix\n# branch.upstream origin/fix\n', 'abcdef1\0x')).toContain('upstream `origin/fix` gone or never fetched')
    expect(line(STATUS, '')).toContain('3 changed, 1 untracked, 1 conflicted files')
  })
})

describe('unquote', () => {
  test('decodes the escapes and octal bytes git quotes a path with', () => {
    expect(unquote('plain.ts')).toBe('plain.ts')
    expect(unquote('"a\\"b\\\\c\\td.ts"')).toBe('a"b\\c\td.ts')
    expect(unquote('"caf\\303\\251.ts"')).toBe('café.ts')
  })
})
