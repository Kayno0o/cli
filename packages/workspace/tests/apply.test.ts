import type { Entry } from '../src/sweep-scan'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { applyAll, wtTaskFor } from '../src/apply'

const temp = tempDirs()

function entry(path: string, overrides: Partial<Entry> = {}): Entry {
  return { path, kind: 'folder', bytes: 0, committedAt: undefined, action: 'remove', ...overrides }
}

describe('applyAll', () => {
  test('removes a plain listed folder and reports each outcome as it goes', async () => {
    const root = temp('apply-')
    const target = join(root, 'node_modules')
    const seen: string[] = []

    mkdirSync(join(target, 'dep'), { recursive: true })

    const outcomes = await applyAll([entry(target)], outcome => seen.push(outcome.path))

    expect(outcomes).toEqual([{ path: target, removed: true }])
    expect(seen).toEqual([target])
    expect(existsSync(target)).toBe(false)
  })

  test('never touches a kept entry and does not report it', async () => {
    const root = temp('apply-')
    const target = join(root, 'dist')

    mkdirSync(target)

    const outcomes = await applyAll([entry(target, { action: 'keep', reason: 'dirty' })], () => undefined)

    expect(outcomes).toEqual([])
    expect(existsSync(target)).toBe(true)
  })

  test('refuses a path that is a symlink now, a file, or no longer bears a listed name', async () => {
    const root = temp('apply-')
    const real = join(root, 'real')
    const link = join(root, 'dist')
    const file = join(root, 'build')
    const renamed = join(root, 'precious')

    mkdirSync(real)
    mkdirSync(renamed)
    symlinkSync(real, link)
    writeFileSync(file, '')

    const outcomes = await applyAll([entry(link), entry(file), entry(renamed)], () => undefined)

    expect(outcomes.map(outcome => outcome.removed)).toEqual([false, false, false])
    expect(outcomes.every(outcome => outcome.error === 'no longer a plain folder')).toBe(true)
    expect(existsSync(real) && existsSync(renamed)).toBe(true)
  })

  test('refuses a folder that now holds a git repository', async () => {
    const root = temp('apply-')
    const target = join(root, 'node_modules')

    mkdirSync(join(target, '.git'), { recursive: true })

    expect(await applyAll([entry(target)], () => undefined)).toEqual([{ path: target, removed: false, error: 'holds a git repository' }])
    expect(existsSync(target)).toBe(true)
  })

  test('a cache is removed only at an allowlisted path', async () => {
    const root = temp('apply-')
    const allowed = join(root, 'app', 'node_modules', '.cache')
    const stray = join(root, 'app', '.cache')

    mkdirSync(allowed, { recursive: true })
    mkdirSync(stray, { recursive: true })

    const outcomes = await applyAll([entry(allowed, { kind: 'cache' }), entry(stray, { kind: 'cache' })], () => undefined)

    expect(outcomes.map(outcome => outcome.removed)).toEqual([true, false])
    expect(existsSync(stray)).toBe(true)
  })

  test('a worktree with no known repository is not removed', async () => {
    const root = temp('apply-')
    const target = join(root, 'wt')

    mkdirSync(target)

    expect(await applyAll([entry(target, { kind: 'worktree' })], () => undefined)).toEqual([{ path: target, removed: false, error: 'no repository known' }])
    expect(existsSync(target)).toBe(true)
  })

  test('carries git\'s refusal of a worktree it does not know', async () => {
    const root = temp('apply-')
    const target = join(root, 'wt')

    mkdirSync(target)

    const [outcome] = await applyAll([entry(target, { kind: 'worktree', repo: root })], () => undefined)

    expect(outcome?.removed).toBe(false)
    expect(outcome?.error).not.toBe('')
    expect(existsSync(target)).toBe(true)
  })

  test('detects wt-managed worktrees under .worktrees/<repo>/<task> and delegates cleanup to wt rm', async () => {
    const root = temp('apply-wt-')
    const repo = join(root, 'myrepo')
    const target = join(root, '.worktrees', 'myrepo', 'feat')
    const bin = join(root, 'bin')
    const log = join(root, 'wt.log')

    mkdirSync(repo, { recursive: true })
    mkdirSync(target, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'wt'), `#!/bin/sh\necho "$PWD:$*" > "${log}"\nrm -rf "${target}"\n`, { mode: 0o755 })

    expect(wtTaskFor(entry(target, { kind: 'worktree', repo }))).toEqual({ task: 'feat', repo })
    expect(wtTaskFor(entry(join(root, 'other', 'feat'), { kind: 'worktree', repo }))).toBeUndefined()

    const oldPath = process.env.PATH

    process.env.PATH = `${bin}:${oldPath ?? ''}`

    try {
      const [outcome] = await applyAll([entry(target, { kind: 'worktree', repo })], () => undefined)

      expect(outcome).toEqual({ path: target, removed: true })
      expect(existsSync(target)).toBe(false)
      expect(await Bun.file(log).text()).toBe(`${repo}:rm feat\n`)
    }
    finally {
      process.env.PATH = oldPath
    }
  })
})
