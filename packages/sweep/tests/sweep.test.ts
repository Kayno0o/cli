import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/sweep.ts', import.meta.url).pathname
const temp = tempDirs()
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

interface Entry { path: string, kind: string, bytes: number, action: string, reason: string | null }
interface Listing { entries: Entry[], skipped: { path: string, reason: string }[], reclaimable: number, removed?: { path: string, removed: boolean }[] }

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...IDENTITY, ...env } })

  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)

  return result.stdout.toString()
}

function sweep(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...IDENTITY, NO_COLOR: '1', ...env } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function listing(args: string[], env: Record<string, string> = {}): Listing {
  return JSON.parse(sweep([...args, '--json'], env).out) as Listing
}

// A repo with one commit that ignores the folders sweep targets, `date` being its commit date.
function repo(root: string, name: string, date = '2026-01-01T00:00:00Z'): string {
  const dir = join(root, name)

  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\nbuild\ntarget\n.worktrees\n')
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })

  return dir
}

function fill(folder: string, bytes: number): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'file'), 'x'.repeat(bytes))
}

describe('sweep', () => {
  test('lists the folders largest first with the total, and deletes nothing without --apply', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, 'node_modules'), 3000)
    fill(join(a, 'dist'), 5000)

    const result = listing([root])

    expect(result.entries.map(entry => [entry.path, entry.bytes, entry.action])).toEqual([[join(a, 'dist'), 5000, 'remove'], [join(a, 'node_modules'), 3000, 'remove']])
    expect(result.reclaimable).toBe(8000)
    expect(sweep([root]).code).toBe(0)
    expect(sweep([root, '--yes']).code).toBe(0)
    expect(existsSync(join(a, 'node_modules', 'file'))).toBe(true)
    expect(existsSync(join(a, 'dist', 'file'))).toBe(true)
  })

  test('--apply refuses off a terminal without --yes, then deletes with it', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, 'node_modules'), 100)

    expect(sweep([root, '--apply'])).toMatchObject({ code: 2 })
    expect(existsSync(join(a, 'node_modules'))).toBe(true)

    const done = listing([root, '--apply', '--yes'])

    expect(done.removed).toEqual([{ path: join(a, 'node_modules'), removed: true }])
    expect(existsSync(join(a, 'node_modules'))).toBe(false)
    expect(existsSync(join(a, 'a.txt'))).toBe(true)
  })

  test('skips a folder git tracks files in, a symlink, and a build folder git does not ignore', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')
    const outside = temp('outside-')

    fill(join(a, 'build'), 10)
    writeFileSync(join(a, 'build', 'tracked.js'), 'x')
    git(a, ['add', '-f', 'build/tracked.js'])
    git(a, ['commit', '-q', '-m', 'track'])
    fill(outside, 10)
    symlinkSync(outside, join(a, 'node_modules'))
    fill(join(a, '.next'), 10)

    const result = listing([root])

    expect(result.entries).toEqual([])
    expect(Object.fromEntries(result.skipped.map(skip => [skip.path, skip.reason]))).toEqual({
      [join(a, 'build')]: 'tracked by git',
      [join(a, 'node_modules')]: 'symlink',
      [join(a, '.next')]: 'not ignored by git',
    })
    expect(sweep([root, '--apply', '--yes']).code).toBe(0)
    expect(existsSync(join(a, 'build', 'tracked.js'))).toBe(true)
    expect(existsSync(join(outside, 'file'))).toBe(true)
    expect(existsSync(join(a, '.next', 'file'))).toBe(true)
  })

  test('skips a folder holding its own repository, and everything when git cannot run', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, 'node_modules'), 10)
    fill(join(a, 'dist'), 10)
    mkdirSync(join(a, 'dist', '.git'))

    const nested = listing([root])

    expect(nested.entries.map(entry => entry.path)).toEqual([join(a, 'node_modules')])
    expect(nested.skipped.find(skip => skip.path === join(a, 'dist'))?.reason).toBe('holds a git repository')

    const blind = listing([root], { PATH: '/nonexistent' })

    expect(blind.entries).toEqual([])
    expect(blind.skipped.map(skip => skip.reason)).toEqual(['git failed', 'git failed'])
    expect(existsSync(join(a, 'node_modules', 'file'))).toBe(true)
  })

  test('a target folder counts only beside a Cargo.toml', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')
    const b = repo(root, 'b')

    fill(join(a, 'target'), 10)
    fill(join(b, 'target'), 10)
    writeFileSync(join(b, 'Cargo.toml'), '')

    expect(listing([root]).entries.map(entry => entry.path)).toEqual([join(b, 'target')])
  })

  test('does not descend into a candidate or look deeper than three levels', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, 'node_modules', 'pkg', 'node_modules'), 10)
    fill(join(root, 'x', 'y', 'z', 'w', 'node_modules'), 10)

    expect(listing([root]).entries.map(entry => entry.path)).toEqual([join(a, 'node_modules')])
  })

  test('lists a clean worktree as removable and removes it with git, keeping the branch', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    git(a, ['worktree', 'add', '-q', '.worktrees/clean', '-b', 'clean'])

    expect(listing([root]).entries).toMatchObject([{ path: join(a, '.worktrees', 'clean'), kind: 'worktree', action: 'remove' }])

    const done = listing([root, '--apply', '--yes'])

    expect(done.removed).toEqual([{ path: join(a, '.worktrees', 'clean'), removed: true }])
    expect(existsSync(join(a, '.worktrees', 'clean'))).toBe(false)
    expect(git(a, ['branch', '--list', 'clean'])).toContain('clean')
  })

  test('--only picks one kind, and a .claude/worktrees entry is a worktree with its node_modules inside it', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    git(a, ['worktree', 'add', '-q', '.claude/worktrees/agent', '-b', 'agent'])
    fill(join(a, '.claude', 'worktrees', 'agent', 'node_modules'), 10)
    fill(join(a, 'node_modules'), 10)

    expect(listing([root]).entries.map(entry => `${entry.kind} ${entry.path}`).toSorted()).toEqual([`folder ${join(a, 'node_modules')}`, `worktree ${join(a, '.claude', 'worktrees', 'agent')}`])
    expect(listing([root, '--only', 'worktrees']).entries.map(entry => entry.kind)).toEqual(['worktree'])
    expect(listing([root, '--only', 'folders']).entries.map(entry => entry.kind)).toEqual(['folder'])
    expect(sweep([root, '--only', 'both']).code).toBe(2)
    expect(sweep([root, '--only', 'worktrees', '--apply', '--yes']).code).toBe(0)
    expect(existsSync(join(a, '.claude', 'worktrees', 'agent'))).toBe(false)
    expect(existsSync(join(a, 'node_modules', 'file'))).toBe(true)
  })

  test('never lists a dirty worktree or one with unpushed commits as removable, and --apply leaves them', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    git(a, ['worktree', 'add', '-q', '.worktrees/dirty', '-b', 'dirty'])
    writeFileSync(join(a, '.worktrees', 'dirty', 'new.txt'), 'wip')
    git(a, ['worktree', 'add', '-q', '.worktrees/ahead', '-b', 'ahead'])
    writeFileSync(join(a, '.worktrees', 'ahead', 'work.txt'), 'work')
    git(join(a, '.worktrees', 'ahead'), ['add', '.'])
    git(join(a, '.worktrees', 'ahead'), ['commit', '-q', '-m', 'work'])

    const result = listing([root])

    expect(result.entries.map(entry => [entry.path, entry.action, entry.reason]).sort()).toEqual([
      [join(a, '.worktrees', 'ahead'), 'keep', '1 commits on no other branch or remote'],
      [join(a, '.worktrees', 'dirty'), 'keep', 'uncommitted changes'],
    ])
    expect(result.entries.some(entry => entry.action === 'remove')).toBe(false)
    expect(result.reclaimable).toBe(0)
    expect(listing([root, '--apply', '--yes']).removed).toEqual([])
    expect(existsSync(join(a, '.worktrees', 'dirty', 'new.txt'))).toBe(true)
    expect(existsSync(join(a, '.worktrees', 'ahead', 'work.txt'))).toBe(true)
  })

  test('keeps a worktree holding ignored files that removing would delete, but not one with only build folders', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    writeFileSync(join(a, '.gitignore'), 'node_modules\ndist\nbuild\ntarget\n.worktrees\n.env\n')
    git(a, ['commit', '-q', '-am', 'ignore env'])
    git(a, ['worktree', 'add', '-q', '.worktrees/secret', '-b', 'secret'])
    writeFileSync(join(a, '.worktrees', 'secret', '.env'), 'TOKEN=1')
    git(a, ['worktree', 'add', '-q', '.worktrees/built', '-b', 'built'])
    fill(join(a, '.worktrees', 'built', 'node_modules'), 10)

    const entries = listing([root]).entries.filter(entry => entry.kind === 'worktree')

    expect(entries.map(entry => [entry.path, entry.action]).sort()).toEqual([[join(a, '.worktrees', 'built'), 'remove'], [join(a, '.worktrees', 'secret'), 'keep']])
    expect(listing([root, '--apply', '--yes']).removed).toEqual([{ path: join(a, '.worktrees', 'built'), removed: true }])
    expect(existsSync(join(a, '.worktrees', 'secret', '.env'))).toBe(true)
  })

  test('a worktree whose commits were merged into another branch is removable', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    git(a, ['worktree', 'add', '-q', '.worktrees/done', '-b', 'done'])
    writeFileSync(join(a, '.worktrees', 'done', 'work.txt'), 'work')
    git(join(a, '.worktrees', 'done'), ['add', '.'])
    git(join(a, '.worktrees', 'done'), ['commit', '-q', '-m', 'work'])
    git(a, ['merge', '-q', 'done'])

    expect(listing([root]).entries).toMatchObject([{ path: join(a, '.worktrees', 'done'), action: 'remove' }])
  })

  test('a folder named .worktrees/x that git does not know is skipped', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, '.worktrees', 'stray'), 10)

    expect(listing([root])).toMatchObject({ entries: [], skipped: [{ path: join(a, '.worktrees', 'stray'), reason: 'not a worktree of this repo' }] })
  })

  test('--min and --older narrow the list and the total', () => {
    const root = temp('sweep-')
    const old = repo(root, 'old', '2020-01-01T00:00:00Z')
    const fresh = repo(root, 'fresh', new Date().toISOString())

    fill(join(old, 'node_modules'), 5000)
    fill(join(old, 'dist'), 100)
    fill(join(fresh, 'node_modules'), 9000)

    expect(listing([root, '--min', '1K']).entries.map(entry => entry.path)).toEqual([join(fresh, 'node_modules'), join(old, 'node_modules')])
    expect(listing([root, '--older', '30d']).entries.map(entry => entry.path)).toEqual([join(old, 'node_modules'), join(old, 'dist')])

    const both = listing([root, '--older', '30d', '--min', '1K'])

    expect(both.entries.map(entry => entry.path)).toEqual([join(old, 'node_modules')])
    expect(both.reclaimable).toBe(5000)
  })

  test('--apply with a filter deletes only what the filter kept', () => {
    const root = temp('sweep-')
    const a = repo(root, 'a')

    fill(join(a, 'node_modules'), 5000)
    fill(join(a, 'dist'), 100)
    listing([root, '--min', '1K', '--apply', '--yes'])

    expect(existsSync(join(a, 'node_modules'))).toBe(false)
    expect(existsSync(join(a, 'dist', 'file'))).toBe(true)
  })

  test('rejects a bad size, a bad duration and a missing root', () => {
    const root = temp('sweep-')

    expect(sweep([root, '--min', 'big']).code).toBe(2)
    expect(sweep([root, '--older', 'old']).code).toBe(2)
    expect(sweep([join(root, 'missing')]).code).toBe(2)
  })

  test('says so when there is nothing to sweep', () => {
    expect(sweep([temp('sweep-')])).toMatchObject({ code: 0, out: 'nothing to sweep\n' })
  })
})
