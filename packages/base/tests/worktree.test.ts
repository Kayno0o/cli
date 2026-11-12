import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, spyOn, test } from 'bun:test'
import { copyKept, folded, keptPaths, linkedEntries, linkEntries, removeTree, shellCommand } from '../src/worktree'

const temp = tempDirs()
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function gitRepo(): string {
  const root = temp('wt-')

  Bun.spawnSync(['git', 'init', '-q', root], { env: GIT_ENV })

  return root
}

function exit(run: () => unknown): { message: string, code: number } {
  try {
    run()
  }
  catch (error) {
    const { message, code } = error as { message: string, code: number }

    return { message, code }
  }

  throw new Error('did not fail')
}

describe('shellCommand', () => {
  test('one argument with spaces is a shell line, anything else goes as given', () => {
    expect(shellCommand(['bun test a | tail'])).toEqual(['sh', '-c', 'bun test a | tail'])
    expect(shellCommand(['bun', 'test a'])).toEqual(['bun', 'test a'])
    expect(shellCommand(['bun'])).toEqual(['bun'])
  })
})

describe('folded', () => {
  test('keeps up to 120 lines whole', () => {
    const lines = Array.from({ length: 120 }, (_, index) => `l${index}`)

    expect(folded(`${lines.join('\n')}\n\n`)).toBe(lines.join('\n'))
  })

  test('folds a longer output to its first 20 and last 80 lines around a count', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `l${index}`)
    const out = folded(lines.join('\n')).split('\n')

    expect(out).toHaveLength(101)
    expect(out[0]).toBe('l0')
    expect(out[19]).toBe('l19')
    expect(out[20]).toContain('200 lines omitted')
    expect(out[21]).toBe('l220')
    expect(out.at(-1)).toBe('l299')
  })
})

describe('keptPaths', () => {
  test('answers repository paths relative to the root, from a subfolder', () => {
    const root = temp('wt-')

    mkdirSync(join(root, 'api'))
    writeFileSync(join(root, 'api', 'a.txt'), '')
    writeFileSync(join(root, 'b.txt'), '')

    expect(keptPaths(root, join(root, 'api'), ['a.txt', '../b.txt'])).toEqual(['api/a.txt', 'b.txt'])
  })

  test('refuses a missing file and a path outside the repository', () => {
    const root = temp('wt-')
    const outside = temp('wt-out-')

    writeFileSync(join(outside, 'x'), '')

    expect(exit(() => keptPaths(root, root, ['nope.txt']))).toMatchObject({ code: 2, message: expect.stringContaining('no such file') })
    expect(exit(() => keptPaths(root, root, [join(outside, 'x')])).message).toContain('outside the repository')
    expect(exit(() => keptPaths(root, root, ['..'])).message).toContain('outside the repository')
  })
})

describe('linkedEntries', () => {
  test('lists ignored env files and dependency folders only', async () => {
    const root = gitRepo()

    writeFileSync(join(root, '.gitignore'), '.env\n.env.local\nnode_modules/\nvendor/\ndist/\nnotes.txt\n')
    writeFileSync(join(root, '.env'), '')
    writeFileSync(join(root, '.env.local'), '')
    writeFileSync(join(root, 'notes.txt'), '')
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'vendor'))
    mkdirSync(join(root, 'dist'))

    expect((await linkedEntries(root)).toSorted()).toEqual(['.env', '.env.local', 'node_modules', 'vendor'])
  })

  test('answers empty outside a repository', async () => {
    expect(await linkedEntries(temp('wt-'))).toEqual([])
  })
})

describe('linkEntries', () => {
  test('symlinks an entry to the checkout, leaves an existing one and returns the links made', () => {
    const root = temp('wt-')
    const dir = temp('wt-dir-')

    writeFileSync(join(root, '.env'), 'secret')
    writeFileSync(join(root, '.env.local'), 'x')
    writeFileSync(join(dir, '.env.local'), 'own')

    const links = linkEntries(root, dir, ['.env', '.env.local'])

    expect(links).toEqual([join(dir, '.env')])
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('secret')
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe('own')
  })
})

describe('copyKept', () => {
  test('copies over what the worktree has, creating folders', () => {
    const root = temp('wt-')
    const dir = temp('wt-dir-')

    mkdirSync(join(root, 'a'))
    writeFileSync(join(root, 'a', 'new.txt'), 'wip')
    writeFileSync(join(dir, 'old.txt'), 'old')
    writeFileSync(join(root, 'old.txt'), 'wip-old')

    copyKept(root, dir, ['a/new.txt', 'old.txt'])

    expect(readFileSync(join(dir, 'a', 'new.txt'), 'utf8')).toBe('wip')
    expect(readFileSync(join(dir, 'old.txt'), 'utf8')).toBe('wip-old')
  })

  test('refuses to write through a symlink of the ref, leaving the target alone', () => {
    const root = temp('wt-')
    const dir = temp('wt-dir-')
    const outside = temp('wt-out-')

    mkdirSync(join(root, 'link'))
    writeFileSync(join(root, 'link', 'f.txt'), 'wip')
    symlinkSync(outside, join(dir, 'link'))

    expect(exit(() => copyKept(root, dir, ['link/f.txt'])).message).toContain('symlink')
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })
})

describe('removeTree', () => {
  test('empties read-only folders, and warns instead of throwing on what it still cannot remove', () => {
    const root = temp('rm-')

    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'f'), '')
    chmodSync(join(root, 'a', 'b'), 0o555)
    removeTree(join(root, 'a'))
    expect(existsSync(join(root, 'a'))).toBe(false)

    if (process.getuid?.() === 0)
      return

    const warned = spyOn(console, 'error').mockImplementation(() => undefined)
    let warning = ''

    mkdirSync(join(root, 'kept'))
    chmodSync(root, 0o555)

    try {
      removeTree(join(root, 'kept'))
      warning = String(warned.mock.calls[0]?.[0])
    }
    finally {
      chmodSync(root, 0o755)
      warned.mockRestore()
    }

    expect(existsSync(join(root, 'kept'))).toBe(true)
    expect(warning).toContain(`could not remove ${join(root, 'kept')}`)
  })
})
