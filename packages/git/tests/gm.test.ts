import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { conflictHunks } from '../src/conflicts'

const GM = new URL('../src/gm.ts', import.meta.url).pathname
// The user's global hooks and settings stay out of the test repositories.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NO_COLOR: '1' }

let dir = ''

// Every call names the repository it runs in, none changes the test process's own folder.
function run(argv: string[]) {
  const result = Bun.spawnSync(argv, { cwd: dir, env: ENV, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

const git = (...args: string[]) => run(['git', ...args]).out.trim()
const gm = (...args: string[]) => run([process.execPath, GM, ...args])

function commit(name: string, text: string, message = `edit ${name}`): void {
  writeFileSync(join(dir, name), text)
  git('add', name)
  git('commit', '-q', '-m', message)
}

// main holds base.txt; `feature` adds a commit on a.txt and one on b.txt; main moves on a.txt too when `diverge` is set.
function setup(diverge: boolean, conflict = false): void {
  commit('base.txt', 'base\n')
  commit('a.txt', 'one\ntwo\nthree\nfour\nfive\n')
  git('checkout', '-q', '-b', 'feature')
  commit('a.txt', 'one\ntwo\nTHREE from feature\nfour\nfive\n', 'feature a')
  commit('b.txt', 'b\n', 'feature b')
  git('checkout', '-q', 'main')

  if (diverge)
    commit(conflict ? 'a.txt' : 'c.txt', conflict ? 'one\ntwo\nthree from main\nfour\nfive\n' : 'c\n', 'main moves')
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-gm-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('conflictHunks', () => {
  test('finds each region with two lines of context and merges the ones that meet', () => {
    const text = ['1', '2', '3', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', '9', '10', '11', '12', '13', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> feature', '19'].join('\n')
    const hunks = conflictHunks(text)

    expect(hunks.map(hunk => [hunk.from, hunk.to])).toEqual([[2, 10], [12, 19]])
    expect(hunks[0]?.lines[2]).toEqual({ line: 4, text: '<<<<<<< HEAD' })
    expect(conflictHunks('no markers\n')).toEqual([])
  })
})

describe('gm', () => {
  test('from a subfolder lists every conflict of the repository, relative to it, and --continue checks them all', () => {
    mkdirSync(join(dir, 'sub'))
    commit('g', 'base\n')
    commit('sub/f', 'base\n')
    git('checkout', '-q', '-b', 'feat')
    commit('g', 'feat\n')
    commit('sub/f', 'feat\n')
    git('checkout', '-q', '-')
    commit('g', 'main\n')
    commit('sub/f', 'main\n')

    const fromSub = (...args: string[]) => Bun.spawnSync([process.execPath, GM, ...args], { cwd: join(dir, 'sub'), env: ENV, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const merged = fromSub('feat').stdout.toString()

    expect(merged).toContain('left 2 conflicted files')
    expect(merged).toContain('../g:1-6')
    expect(merged).toContain('\nf:1-6')

    writeFileSync(join(dir, 'sub', 'f'), 'resolved\n')

    expect(fromSub('--continue').stdout.toString()).toContain('../g')
  })

  test('fast-forwards and says the commits and files that came in', () => {
    setup(false)
    const result = gm('feature')

    expect(result.code).toBe(0)
    expect(result.out).toContain('main <- feature, fast-forward, 2 commits, 2 files changed')
    expect(result.out).toContain('  M a.txt')
    expect(result.out).toContain('  A b.txt')
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'feature'))
  })

  test('makes a merge commit when the branches diverged, with --json', () => {
    setup(true)
    const result = gm('feature', '--json')
    const parsed = JSON.parse(result.out) as { outcome: string, commits: number, files: { status: string, path: string }[] }

    expect(parsed).toMatchObject({ outcome: 'merge', commits: 2 })
    expect(parsed.files.map(file => file.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  test('says a merged branch is already in, and refuses an edit in a file the merge changes or an unknown branch', () => {
    setup(true)
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')

    expect(gm('feature')).toMatchObject({ code: 1, err: expect.stringContaining('files the merge changes (a.txt)') })

    git('checkout', '-q', '--', 'a.txt')

    expect(gm('nope').code).toBe(1)
    expect(gm('feature').code).toBe(0)
    expect(gm('feature').out).toContain('already contains feature')
  })

  test('merges past an unstaged edit in a file the merge leaves alone, keeping it', () => {
    setup(true)
    writeFileSync(join(dir, 'base.txt'), 'mine\n')

    expect(gm('feature').code).toBe(0)
    expect(readFileSync(join(dir, 'base.txt'), 'utf8')).toBe('mine\n')
    expect(git('show', 'HEAD:base.txt')).toBe('base')
  })

  test('refuses staged changes, which would go into the merge commit', () => {
    setup(true)
    writeFileSync(join(dir, 'base.txt'), 'mine\n')
    git('add', 'base.txt')

    expect(gm('feature')).toMatchObject({ code: 1, err: expect.stringContaining('staged changes would go into the merge (base.txt)') })
  })

  test('keeps an unrelated unstaged edit through a conflict and --abort', () => {
    setup(true, true)
    writeFileSync(join(dir, 'base.txt'), 'mine\n')

    expect(gm('feature').code).toBe(1)
    expect(gm('--abort').code).toBe(0)
    expect(readFileSync(join(dir, 'base.txt'), 'utf8')).toBe('mine\n')
  })

  test('lists every conflicted file with its regions and exits 1, then --abort restores', () => {
    setup(true, true)
    const result = gm('feature')

    expect(result.code).toBe(1)
    expect(result.out).toContain('left 1 conflicted file')
    expect(result.out).toContain('a.txt:1-9')
    expect(result.out).toContain('3  <<<<<<< HEAD')
    expect(result.out).toContain('4  three from main')

    expect(gm('--abort').out).toContain('aborted')
    expect(git('status', '--porcelain')).toBe('')
    expect(gm('--abort').code).toBe(1)
  })

  test('--json carries the hunks, --continue refuses while markers remain then commits', () => {
    setup(true, true)

    const parsed = JSON.parse(gm('feature', '--json').out) as { outcome: string, conflicts: { path: string, hunks: { from: number, to: number }[] }[] }

    expect(parsed.outcome).toBe('conflict')
    expect(parsed.conflicts[0]).toMatchObject({ path: 'a.txt', hunks: [{ from: 1, to: 9 }] })

    const refused = gm('--continue')

    expect(refused.code).toBe(1)
    expect(refused.out).toContain('conflict markers remain in a.txt')

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nresolved\nfour\nfive\n')
    const done = gm('--continue')

    expect(done.code).toBe(0)
    expect(done.out).toContain('merge commit')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('resolved')
    expect(git('status', '--porcelain')).toBe('')
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  test('--dry-run says whether it would conflict and where, touching nothing', () => {
    setup(true)

    expect(gm('--dry-run', 'feature')).toMatchObject({ code: 0, out: expect.stringContaining('would not conflict') })

    git('checkout', '-q', '-b', 'other', 'main~0')
    commit('a.txt', 'one\ntwo\nother three\nfour\nfive\n', 'other a')

    const head = git('rev-parse', 'HEAD')
    const result = gm('--dry-run', 'feature')

    expect(result.code).toBe(1)
    expect(result.out).toContain('would conflict in 1 file')
    expect(result.out).toContain('  a.txt')
    expect(JSON.parse(gm('--dry-run', 'feature', '--json').out)).toMatchObject({ outcome: 'conflict', conflicts: [{ path: 'a.txt' }] })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('status', '--porcelain')).toBe('')
  })

  test('--squash stages the changes without a merge commit', () => {
    setup(true)
    const head = git('rev-parse', 'HEAD')
    const result = gm('feature', '--squash')

    expect(result.code).toBe(0)
    expect(result.out).toContain('squashed into the index of main: 2 commits, 2 files')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('diff', '--cached', '--name-only').split('\n').sort()).toEqual(['a.txt', 'b.txt'])
  })

  test('with no branch and no terminal lists the branches with their verdict', () => {
    setup(true)
    git('branch', 'merged', 'main')
    git('checkout', '-q', '-b', 'clash', 'main')
    commit('a.txt', 'one\ntwo\nclash three\nfour\nfive\n', 'clash a')
    git('checkout', '-q', 'main')

    const plain = gm()

    expect(plain.code).toBe(0)
    expect(plain.out).toMatch(/feature\s+2 ahead, 1 behind\s+clean/)
    expect(plain.out).toMatch(/clash\s+1 ahead, 0 behind\s+clean/)
    expect(plain.out).toMatch(/merged\s+0 ahead, 0 behind\s+merged already/)

    git('checkout', '-q', 'feature')

    const rows = JSON.parse(gm('--json').out) as { name: string, outcome: string, conflicts: string[] }[]

    expect(rows.find(row => row.name === 'clash')).toMatchObject({ outcome: 'conflict', conflicts: ['a.txt'] })
    expect(rows.find(row => row.name === 'main')).toMatchObject({ ahead: 1, behind: 2, outcome: 'clean' })
    expect(rows.find(row => row.name === 'feature')).toBeUndefined()
  })

  test('refuses outside a repository', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cli-gm-outside-')))
    const result = Bun.spawnSync([process.execPath, GM, 'feature'], { cwd: outside, env: { ...ENV, GIT_CEILING_DIRECTORIES: tmpdir() }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    rmSync(outside, { recursive: true, force: true })
    expect(result.exitCode).toBe(2)
  })
})
