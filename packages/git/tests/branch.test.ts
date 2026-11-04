import type { Branch } from '../src/branch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { branches, goTo, invalid, ordered, remove, status, tags, track, visited } from '../src/branch'

const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({ name, remote: false, worktree: '', when: '', subject: '', date: 0, upstream: '', track: '', merged: false, ...extra })
const plain = (text: string) => Bun.stripANSI(text)

describe('visited', () => {
  test('reads the branches from the newest checkout, where it went before where it came from', () => {
    expect(visited([
      'checkout: moving from feat to main',
      'commit: work',
      'checkout: moving from old to feat',
      'checkout: moving from main to old',
    ])).toEqual(['main', 'feat', 'old'])
  })
})

describe('ordered', () => {
  test('puts the local branches by last checkout, then by last commit, then the remote ones no local branch tracks', () => {
    const all = [
      branch('main'),
      branch('stale', { date: 1 }),
      branch('fresh', { date: 5 }),
      branch('feat'),
      branch('origin/feat', { remote: true }),
      branch('origin/other', { remote: true, date: 3 }),
    ]

    expect(ordered(all, ['main', 'feat'], 'main').map(found => found.name)).toEqual(['feat', 'fresh', 'stale', 'origin/other'])
  })
})

describe('goTo', () => {
  test('goes to a worktree, switches to a local branch, and tracks a remote one', () => {
    expect(goTo(branch('feat', { worktree: '/tmp/wt-feat' }))).toEqual(['cd', '/tmp/wt-feat'])
    expect(goTo(branch('old'))).toEqual(['git', 'switch', 'old'])
    expect(goTo(branch('origin/other', { remote: true }))).toEqual(['git', 'switch', '--track', 'origin/other'])
  })
})

describe('remove', () => {
  test('deletes a local branch with git branch -d', () => {
    expect(remove(branch('old'))).toEqual(['git', 'branch', '-d', 'old'])
  })

  test('leaves a remote branch to git push --delete', () => {
    expect(() => remove(branch('origin/other', { remote: true }))).toThrow('remote branch')
  })
})

describe('track', () => {
  test('keeps what git says of the upstream, without the comma', () => {
    expect(plain(track('ahead 2, behind 1'))).toBe('ahead 2 behind 1')
    expect(plain(track('gone'))).toBe('gone')
    expect(track('')).toBe('')
  })
})

describe('tags', () => {
  test('puts where it is checked out before how it stands against its upstream and whether it is merged', () => {
    expect(plain(tags(branch('feat', { worktree: '/tmp/wt-feat', track: 'ahead 1', merged: true })))).toBe('wt wt-feat ahead 1 merged')
    expect(plain(tags(branch('origin/other', { remote: true })))).toBe('remote')
    expect(tags(branch('plain'))).toBe('')
  })
})

describe('status', () => {
  test('names the current branch, its upstream and the uncommitted files', () => {
    expect(plain(status(branch('feat', { upstream: 'origin/feat', track: 'behind 3' }), 'abc1234', 2))).toBe('on feat | origin/feat behind 3 | 2 uncommitted')
    expect(plain(status(branch('feat', { upstream: 'origin/feat' }), 'abc1234', 0))).toBe('on feat | origin/feat up to date')
    expect(plain(status(branch('local'), 'abc1234', 0))).toBe('on local')
  })

  test('names the commit a detached HEAD is on', () => {
    expect(plain(status(undefined, 'abc1234', 0))).toBe('HEAD detached at abc1234')
  })
})

describe('invalid', () => {
  test('takes a name git takes, and says why it refuses an empty one, one with a space or one read as an option', () => {
    expect(invalid('feat/new-thing')).toBe('')
    expect(invalid('')).toBe('Type the name of the new branch first')
    expect(invalid('feat new')).toBe('feat new is not a valid branch name')
    expect(invalid('-x')).toBe('-x is not a valid branch name')
  })
})

describe('in a clone', () => {
  const origin = process.cwd()
  let root = ''
  let clonePath = ''

  const git = (dir: string, ...args: string[]) => {
    const proc = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stderr: 'pipe' })

    if (!proc.success)
      throw new Error(proc.stderr.toString())
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'branch-pick-'))
    const upstream = join(root, 'upstream')
    const clone = join(root, 'clone')

    git(root, 'init', '-q', upstream)
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'base')
    git(upstream, 'branch', 'work')
    git(upstream, 'branch', 'old')
    git(root, 'clone', '-q', upstream, clone)
    git(clone, 'switch', '-q', '--track', 'origin/work')
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git(clone, 'switch', '-q', '--track', 'origin/old')
    git(clone, 'switch', '-q', 'main')
    git(upstream, 'branch', '-D', 'old')
    git(clone, 'fetch', '-q', '--prune')
    process.chdir(clone)
    clonePath = clone
  })

  afterAll(() => {
    process.chdir(origin)
    rmSync(root, { recursive: true, force: true })
  })

  test('reads how each local branch stands against its upstream, and which are merged into the base but the base itself', () => {
    const found = Object.fromEntries(branches('origin/main').map(each => [each.name, each]))

    expect(found.work).toMatchObject({ upstream: 'origin/work', track: 'ahead 1', merged: false })
    expect(found.old).toMatchObject({ upstream: 'origin/old', track: 'gone', merged: true })
    expect(found.main).toMatchObject({ upstream: 'origin/main', track: '', merged: false })
    expect(found['origin/work']).toMatchObject({ remote: true, merged: false })
  })

  const GB = new URL('../src/gb.ts', import.meta.url).pathname
  const gb = (...args: string[]) => Bun.spawnSync([process.execPath, GB, ...args], { cwd: clonePath, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const out = (...args: string[]) => gb(...args).stdout.toString()

  test('gb prints its version and its usage', () => {
    expect(out('--version').trim()).toBe(version)
    expect(out('--help')).toContain('gb [branch]')
  })

  test('gb --emit gives the words of the command for the wrapper reading them', () => {
    expect(out('--emit', 'work')).toBe('run\nwork\n\n=git\n=switch\n=work\n')
    expect(out('--emit', '-')).toBe('run\n-\n\n=git\n=switch\n=-\n')
    expect(out('--emit', '-c', 'feat/new')).toBe('run\n-c feat/new\n\n=git\n=switch\n=-c\n=feat/new\n')
    expect(out('--emit', '-d', 'work')).toBe('run\n-d work\n\n=git\n=branch\n=-d\n=work\n')
  })

  test('gb --list gives the rows tmux_pick reads, each with its preview and its keys, and --emit with no terminal does not open the picker', () => {
    const rows = JSON.parse(out('--list')) as { label: string, typed: string, preview?: string[], asks?: string, actions?: { key: string, reload?: string[] }[] }[]
    const work = rows.find(row => row.label === 'work')

    expect(work).toMatchObject({ typed: 'work', preview: ['--show', 'work'] })
    expect(work?.actions).toEqual([{ label: 'Delete', key: 'ctrl-d', typed: '-d work' }, { label: 'Fetch', key: 'ctrl-r', reload: ['--fetch'] }])
    expect(rows.at(-1)).toMatchObject({ label: 'New branch', typed: '-c', asks: '' })
    expect(out('--show', 'work')).toContain('1 ahead, 0 behind origin/main')
    expect(gb('--emit')).toMatchObject({ exitCode: 1 })
    expect(gb('--emit').stderr.toString()).toContain('the picker needs a terminal')
  })

  test('gb refuses an unknown branch, an invalid new name and a remote branch to delete', () => {
    expect(gb('nope').exitCode).toBe(1)
    expect(gb('--emit', '-c', 'bad name').exitCode).toBe(1)
    expect(gb('--emit', '-d', 'origin/work').exitCode).toBe(1)
  })

  test('gb -d - refuses instead of switching back', () => {
    expect(gb('-d', '-').exitCode).toBe(1)
    expect(gb('--emit', '-d', '-').exitCode).toBe(1)
  })

  test('gb on the current branch or its remote twin says so and exits 0', () => {
    for (const named of ['main', 'origin/main']) {
      const proc = gb(named)

      expect(proc.exitCode).toBe(0)
      expect(proc.stderr.toString()).toContain('already on main')
      expect(proc.stdout.toString()).toBe('')
    }
  })

  test('gb lists the branches for completions and for term, and --emit fails to pick without a terminal', () => {
    expect(out('--names')).toContain('work\t')

    const rows = JSON.parse(out('--list')) as { label: string, typed: string }[]

    expect(rows.map(each => each.label)).toContain('work')
    expect(rows.at(-1)).toMatchObject({ label: 'New branch', typed: '-c', asks: '' })
    expect(gb('--emit').exitCode).toBe(1)
  })

  test('gb lists plain text without a terminal, or JSON', () => {
    expect(out()).toContain('work')
    expect((JSON.parse(out('--json')) as { name: string }[]).map(each => each.name)).toContain('work')
  })
})
