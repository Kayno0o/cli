import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const GST = new URL('../src/gst.ts', import.meta.url).pathname
const GP = new URL('../src/gp.ts', import.meta.url).pathname
// The user's global hooks and settings stay out of the test repositories; commits get a fixed author.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', NO_COLOR: '1' }

// What the table pads its columns with, a tab for an agent.
const COLUMNS = /\t| {2,}/

let top = ''
let root = ''

function run(argv: string[], cwd = root) {
  const result = Bun.spawnSync(argv, { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

const git = (cwd: string, ...args: string[]) => run(['git', ...args], cwd).out.trim()
const gst = (...args: string[]) => run([process.execPath, GST, ...args])
const gp = (...args: string[]) => run([process.execPath, GP, ...args])

// A repository with one commit, at `dir` under the root.
function repo(dir: string): string {
  const path = join(root, dir)

  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  commit(path, 'first')

  return path
}

function commit(path: string, name: string): void {
  writeFileSync(join(path, `${name}.txt`), name)
  git(path, 'add', '.')
  git(path, 'commit', '-qm', name)
}

// A bare remote named origin, the branch pushed to it when `track` says so.
function remote(path: string, name: string, track = true): string {
  const bare = join(top, `${name}.git`)

  git(top, 'init', '-q', '--bare', '-b', 'main', bare)
  git(path, 'remote', 'add', 'origin', bare)

  if (track)
    git(path, 'push', '-q', '-u', 'origin', 'main')

  return bare
}

interface Listed {
  path: string
  branch: string
  ahead: number | null
  upstream: string | null
  untracked: string[]
}

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'cli-git-repos-')))
  root = join(top, 'project')
  repo('.')
  // Nested repositories: one tracked, one with a remote but no upstream, one with no remote; and some never walked into.
  repo('app')
  repo('tools/lib')
  repo('node_modules/dep')
  repo('.data/db')
  writeFileSync(join(root, '.gitignore'), 'app\ntools\nnode_modules\n.data\n')
  git(root, 'add', '.gitignore')
  git(root, 'commit', '-qm', 'ignore')
})

afterEach(() => {
  rmSync(top, { recursive: true, force: true })
})

describe('gst --repos', () => {
  test('lists the repository and the ones nested in it, past dependencies and hidden folders', () => {
    remote(root, 'project')
    commit(root, 'second')
    writeFileSync(join(root, 'app', 'new.txt'), 'x')

    const { code, out } = gst('--repos')

    expect(code).toBe(0)
    expect(out.trimEnd().split('\n').map(line => line.split(COLUMNS))).toEqual([
      ['.', 'main', '1 ahead', 'clean'],
      ['app', 'main', 'no upstream', '1 untracked'],
      ['tools/lib', 'main', 'no upstream', 'clean'],
    ])
  })

  test('--json gives each repository its path and the status gst prints for one', () => {
    const listed = JSON.parse(gst('--repos', '--json').out) as Listed[]

    expect(listed.map(one => one.path)).toEqual(['.', 'app', 'tools/lib'])
    expect(listed[0]).toMatchObject({ branch: 'main', upstream: null, ahead: null, untracked: [] })
    expect(listed[0]).not.toHaveProperty('commits')
  })

  test('walks below the dirs given, paths staying relative to the current directory', () => {
    expect(JSON.parse(gst('--repos', 'tools', '--json').out)).toMatchObject([{ path: 'tools/lib' }])
    expect(gst('--repos', 'nowhere').code).toBe(2)
  })

  test('takes a dir with --repos alone, and no -n with it', () => {
    expect(gst('app').code).toBe(2)
    expect(gst('--repos', '-n', '2').err).toContain('--repos cannot be used with --limit')
  })
})

describe('gp', () => {
  test('pushes a branch ahead, and one with no upstream with -u to origin', () => {
    const bare = remote(root, 'project')
    const app = remote(join(root, 'app'), 'app', false)

    commit(root, 'second')

    const { code, out } = gp('--repos')

    expect(code).toBe(0)
    expect(out.trimEnd().split('\n').map(line => line.split(COLUMNS))).toEqual([
      ['.', 'ok: pushed main -> origin/main, 1 commit'],
      ['app', 'ok: pushed main -> origin/main, 1 commit'],
      ['tools/lib', 'no upstream, and no origin remote to push to'],
    ])
    expect(git(top, '--git-dir', bare, 'log', '-1', '--format=%s', 'main')).toBe('second')
    expect(git(top, '--git-dir', app, 'log', '-1', '--format=%s', 'main')).toBe('first')
    expect(git(join(root, 'app'), 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
  })

  test('without --repos pushes the current repository alone, skipping it when nothing is ahead', () => {
    remote(root, 'project')
    remote(join(root, 'app'), 'app', false)

    expect(gp().out.trim().split(COLUMNS)).toEqual(['.', 'nothing to push'])
    expect(JSON.parse(gp('app', '--json').out)).toEqual([{ path: 'app', branch: 'main', remote: 'origin/main', commits: 1, outcome: 'pushed' }])
  })

  test('--dry-run says what would go out and pushes nothing', () => {
    const bare = remote(root, 'project')

    commit(root, 'second')

    expect(gp('--dry-run').out.trim().split(COLUMNS)).toEqual(['.', 'would push main -> origin/main, 1 commit'])
    expect(git(top, '--git-dir', bare, 'log', '-1', '--format=%s', 'main')).toBe('ignore')
  })

  test('a push the remote refuses exits 1 with git\'s reason, the others still going', () => {
    const bare = remote(root, 'project')
    const other = join(top, 'other')

    git(top, 'clone', '-q', bare, other)
    commit(other, 'theirs')
    git(other, 'push', '-q')
    commit(root, 'mine')
    git(root, 'fetch', '-q')

    const refused = JSON.parse(gp('--json').out) as { outcome: string, reason: string }[]

    expect(gp().code).toBe(1)
    expect(refused[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('rejected') })
  })

  test('a detached HEAD is skipped, and what follows -- goes to git push even with nothing ahead', () => {
    const bare = remote(root, 'project')

    git(root, 'tag', 'v1')
    expect(gp('--', '--tags').code).toBe(0)
    expect(git(top, '--git-dir', bare, 'tag')).toBe('v1')

    git(root, 'checkout', '-q', '--detach')
    expect(gp().out.trim().split(COLUMNS)).toEqual(['.', 'detached HEAD'])
  })

  test('outside a repository it is a usage error', () => {
    expect(run([process.execPath, GP], top).code).toBe(2)
  })
})
