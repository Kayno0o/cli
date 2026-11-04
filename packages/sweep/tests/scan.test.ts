import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { findCandidates, isCachePath } from '../src/scan'

const temp = tempDirs()

function paths(found: { candidates: { path: string }[] }, root: string): string[] {
  return found.candidates.map(candidate => candidate.path.slice(root.length + 1)).toSorted()
}

describe('isCachePath', () => {
  test('accepts only the exact allowlisted paths under home and a node_modules/.cache', () => {
    expect(isCachePath('/h/.bun/install/cache', '/h')).toBe(true)
    expect(isCachePath('/h/.bun/install', '/h')).toBe(false)
    expect(isCachePath('/h/.bun/install/cache/x', '/h')).toBe(false)
    expect(isCachePath('/other/.bun/install/cache', '/h')).toBe(false)
    expect(isCachePath('/p/node_modules/.cache', '/h')).toBe(true)
    expect(isCachePath('/p/src/.cache', '/h')).toBe(false)
  })
})

describe('findCandidates', () => {
  test('finds build folders, project caches and node_modules/.cache, kind by kind', async () => {
    const root = temp('scan-')

    mkdirSync(join(root, 'app', 'node_modules', '.cache'), { recursive: true })
    mkdirSync(join(root, 'app', '.nuxt'), { recursive: true })
    mkdirSync(join(root, 'app', 'src'), { recursive: true })

    const found = await findCandidates(root, join(root, 'nohome'), false)

    expect(paths(found, root)).toEqual(['app/.nuxt', 'app/node_modules', 'app/node_modules/.cache'])
    expect(found.candidates.find(candidate => candidate.path.endsWith('.nuxt'))?.kind).toBe('cache')
    expect(found.candidates.find(candidate => candidate.path.endsWith('node_modules'))?.kind).toBe('folder')
    expect(found.candidates.find(candidate => candidate.path.endsWith('node_modules/.cache'))).toMatchObject({ kind: 'cache', inside: join(root, 'app', 'node_modules') })
  })

  test('a target folder needs a Cargo.toml beside it', async () => {
    const root = temp('scan-')

    mkdirSync(join(root, 'rust', 'target'), { recursive: true })
    mkdirSync(join(root, 'other', 'target'), { recursive: true })
    writeFileSync(join(root, 'rust', 'Cargo.toml'), '')

    expect(paths(await findCandidates(root, join(root, 'nohome'), false), root)).toEqual(['rust/target'])
  })

  test('skips a symlink bearing a candidate name instead of listing it', async () => {
    const root = temp('scan-')

    mkdirSync(join(root, 'real'))
    mkdirSync(join(root, 'app'))
    symlinkSync(join(root, 'real'), join(root, 'app', 'dist'))

    const found = await findCandidates(root, join(root, 'nohome'), false)

    expect(found.candidates).toEqual([])
    expect(found.skipped).toEqual([{ path: join(root, 'app', 'dist'), reason: 'symlink' }])
  })

  test('lists the entries of .worktrees and .claude/worktrees, and skips a worktrees folder elsewhere', async () => {
    const root = temp('scan-')

    mkdirSync(join(root, 'r', '.worktrees', 'a'), { recursive: true })
    mkdirSync(join(root, 'r', '.claude', 'worktrees', 'b'), { recursive: true })
    mkdirSync(join(root, 'r', 'worktrees', 'c'), { recursive: true })

    const found = await findCandidates(root, join(root, 'nohome'), false)

    expect(paths(found, root)).toEqual(['r/.claude/worktrees/b', 'r/.worktrees/a'])
    expect(found.candidates.every(candidate => candidate.kind === 'worktree')).toBe(true)
  })

  test('does not walk into .git or a candidate, and stops three levels down', async () => {
    const root = temp('scan-')

    mkdirSync(join(root, 'a', 'b', 'c', 'd', 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'a', '.git', 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'a', 'node_modules', 'dep', 'node_modules'), { recursive: true })

    expect(paths(await findCandidates(root, join(root, 'nohome'), false), root)).toEqual(['a/node_modules'])
  })

  test('adds the global caches under home only when asked, skipping a symlinked one', async () => {
    const root = temp('scan-')
    const home = temp('scan-home-')

    mkdirSync(join(home, '.npm', '_cacache'), { recursive: true })
    mkdirSync(join(home, 'elsewhere'))
    mkdirSync(join(home, '.cache'))
    symlinkSync(join(home, 'elsewhere'), join(home, '.cache', 'pip'))

    const without = await findCandidates(root, home, false)
    const withGlobal = await findCandidates(root, home, true)

    expect(without.candidates).toEqual([])
    expect(withGlobal.candidates).toEqual([{ path: join(home, '.npm', '_cacache'), kind: 'cache', global: true }])
    expect(withGlobal.skipped).toEqual([{ path: join(home, '.cache', 'pip'), reason: 'symlink' }])
  })
})
