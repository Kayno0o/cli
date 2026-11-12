import type { RepoState } from '../src/repos-scan'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { findRepos, inspect, reasonsOf } from '../src/repos-scan'

const temp = tempDirs()

function state(overrides: Partial<RepoState>): RepoState {
  return { name: 'r', path: '/r', branch: 'main', upstream: null, dirty: 0, ahead: null, behind: null, worktrees: 0, tag: null, unreleased: null, packages: [], fetchFailed: false, unreadable: false, ...overrides }
}

function repo(root: string, ...parts: string[]): string {
  const path = join(root, ...parts)

  mkdirSync(join(path, '.git'), { recursive: true })

  return path
}

describe('reasonsOf', () => {
  test('is empty for a clean repository and for unknown counts', () => {
    expect(reasonsOf(state({}))).toEqual([])
    expect(reasonsOf(state({ ahead: null, behind: null, unreleased: null }))).toEqual([])
  })

  test('names every reason that applies, in a fixed order', () => {
    expect(reasonsOf(state({ dirty: 2, ahead: 1, behind: 3, unreleased: 4 }))).toEqual(['dirty', 'unpushed', 'behind', 'unreleased'])
    expect(reasonsOf(state({ behind: 1 }))).toEqual(['behind'])
  })
})

describe('findRepos', () => {
  test('answers the root alone when it is itself a repository', async () => {
    const root = repo(temp('repos-'))

    mkdirSync(join(root, 'nested', '.git'), { recursive: true })

    expect(await findRepos(root, new Set())).toEqual([root])
  })

  test('walks sorted, stops at a .git, skips hidden, node_modules and named folders', async () => {
    const root = temp('repos-')
    const b = repo(root, 'b')

    repo(root, 'a', 'inner')
    repo(root, '.hidden')
    repo(root, 'node_modules', 'dep')
    repo(root, 'skipme')
    mkdirSync(join(b, 'sub', '.git'), { recursive: true })

    expect(await findRepos(root, new Set(['skipme']))).toEqual([join(root, 'a', 'inner'), b])
  })

  test('takes a linked worktree whose .git is a file, and stops three levels down', async () => {
    const root = temp('repos-')

    mkdirSync(join(root, 'w'))
    writeFileSync(join(root, 'w', '.git'), 'gitdir: /x')
    repo(root, 'a', 'b', 'c')
    repo(root, 'a', 'b', 'c', 'd')

    expect(await findRepos(root, new Set())).toEqual([join(root, 'a', 'b', 'c'), join(root, 'w')])
  })
})

describe('inspect', () => {
  // Root reads any folder, so git has nothing to warn about.
  test.skipIf(process.getuid?.() === 0)('counts no dirty file from a warning git prints on stderr', async () => {
    const root = temp('repos-')

    await $`git init -q -b main && git -c user.name=a -c user.email=a@b -c commit.gpgsign=false commit -q --allow-empty -m base`.cwd(root).quiet()
    mkdirSync(join(root, 'secret'))
    chmodSync(join(root, 'secret'), 0o000)

    try {
      expect((await inspect(root, false)).dirty).toBe(0)
    }
    finally {
      chmodSync(join(root, 'secret'), 0o700)
    }
  })
})
