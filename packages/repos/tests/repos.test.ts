import type { RepoState } from '../src/scan'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { beforeAll, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/repos.ts', import.meta.url).pathname
const temp = tempDirs()
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

let home = ''
let root = ''

function git(cwd: string, ...args: string[]): string {
  const ran = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env: { ...process.env, ...IDENTITY }, stdout: 'pipe', stderr: 'pipe' })

  if (ran.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)

  return ran.stdout.toString().trim()
}

function commit(cwd: string, file: string, text = file): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), `${text}\n${Math.random()}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', `edit ${file}`)
}

function repo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q')
  commit(path, 'README.md')

  return path
}

function repos(args: string[] = [], at = root) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args, at], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...IDENTITY, HOME: home, NO_COLOR: '1' } })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function listed(args: string[] = []): RepoState[] {
  return JSON.parse(repos(['--json', ...args]).out) as RepoState[]
}

function names(args: string[] = []): string[] {
  return listed(args).map(state => state.name)
}

beforeAll(() => {
  home = temp('repos-home-')
  root = temp('repos-root-')

  const clean = repo(join(root, 'clean'))

  git(clean, 'tag', 'v1.0.0')

  commit(repo(join(root, 'dirty')), 'b.txt')
  writeFileSync(join(root, 'dirty', 'b.txt'), 'changed\n')
  writeFileSync(join(root, 'dirty', 'new.txt'), 'new\n')

  const released = repo(join(root, 'group', 'released'))

  git(released, 'tag', 'v1.0.0')
  commit(released, 'one.txt')
  commit(released, 'two.txt')

  const bare = join(temp('repos-remote-'), 'origin.git')

  git(root, 'init', '-q', '--bare', bare)

  const ahead = repo(join(root, 'ahead'))

  git(ahead, 'remote', 'add', 'origin', bare)
  git(ahead, 'push', '-q', '-u', 'origin', 'main')

  git(root, 'clone', '-q', bare, join(root, 'stale'))

  const other = join(temp('repos-other-'), 'other')

  git(root, 'clone', '-q', bare, other)
  commit(other, 'remote.txt')
  commit(other, 'remote2.txt')
  git(other, 'push', '-q')
  commit(ahead, 'local.txt')

  const mono = repo(join(root, 'mono'))

  commit(mono, 'packages/a/a.txt')
  commit(mono, 'packages/b/b.txt')
  git(mono, 'tag', 'a-v1.0.0')
  git(mono, 'tag', 'b-v1.0.0')
  commit(mono, 'packages/a/a2.txt')
  commit(mono, 'packages/a/a3.txt')

  git(repo(join(root, 'ignored')), 'tag', 'v0.1.0')
  repo(join(root, 'node_modules', 'dep'))
  repo(join(root, '.hidden', 'secret'))
  repo(join(root, 'l1', 'l2', 'l3', 'l4', 'too-deep'))
  writeFileSync(join(root, 'ignored', 'x.txt'), 'x\n')
  mkdirSync(join(home, '.config', 'kaynooo-cli'), { recursive: true })
  writeFileSync(join(home, '.config', 'kaynooo-cli', 'repos.json'), JSON.stringify({ skip: ['ignored'] }))
})

describe('repos', () => {
  test('leaves out a clean repository, the skipped ones and what is too deep or hidden', () => {
    expect(names().toSorted()).toEqual(['ahead', 'dirty', 'mono', 'released'])
    expect(names()).not.toContain('clean')
  })

  test('--all keeps the clean repositories', () => {
    expect(names(['--all']).toSorted()).toEqual(['ahead', 'clean', 'dirty', 'mono', 'released', 'stale'])
  })

  test('counts dirty files, tracked and untracked', () => {
    expect(listed().find(state => state.name === 'dirty')).toMatchObject({ dirty: 2, branch: 'main', upstream: null, reasons: ['dirty'] })
  })

  test('counts ahead of a bare upstream', () => {
    expect(listed().find(state => state.name === 'ahead')).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0, reasons: ['unpushed'] })
  })

  test('counts behind only once --fetch refreshed the upstream', () => {
    const stale = join(root, 'stale')
    const asked = (args: string[]) => JSON.parse(repos(['--json', '--all', ...args], stale).out) as RepoState[]

    expect(asked([])[0]).toMatchObject({ ahead: 0, behind: 0, reasons: [] })
    expect(asked(['--fetch'])[0]).toMatchObject({ ahead: 0, behind: 2, fetchFailed: false, reasons: ['behind'] })
  })

  test('counts the commits since the latest tag', () => {
    expect(listed().find(state => state.name === 'released')).toMatchObject({ tag: 'v1.0.0', unreleased: 2, reasons: ['unreleased'] })
  })

  test('counts a monorepo per package folder tag', () => {
    const mono = listed().find(state => state.name === 'mono')

    expect(mono?.packages).toEqual([{ name: 'a', tag: 'a-v1.0.0', unreleased: 2 }, { name: 'b', tag: 'b-v1.0.0', unreleased: 0 }])
    expect(mono?.unreleased).toBe(2)
  })

  test('--only filters by reason', () => {
    expect(names(['--only', 'dirty'])).toEqual(['dirty'])
    expect(names(['--only', 'unreleased']).toSorted()).toEqual(['mono', 'released'])
    expect(names(['--only', 'unpushed'])).toEqual(['ahead'])
    expect(names(['--only', 'behind', '--fetch']).toSorted()).toEqual(['ahead', 'stale'])
    expect(repos(['--only', 'nope']).code).toBe(2)
  })

  test('prints a table with the footer on the last fetch, and says when nothing needs attention', () => {
    const { code, out } = repos()

    expect(code).toBe(0)
    expect(out).toContain('unreleased')
    expect(out).toContain('2 since v1.0.0')
    expect(out).toContain('a 2')
    expect(out).toContain('as of the last fetch')
    expect(out).not.toContain('clean')

    const empty = temp('repos-empty-')

    repo(join(empty, 'only'))
    expect(repos([], empty).out).toBe('nothing needs attention in 1 repositories\n')
  })

  test('a missing root is a usage error', () => {
    expect(repos([], join(root, 'nowhere')).code).toBe(2)
  })

  test('flags a repository git cannot read instead of showing it clean', () => {
    const broken = temp('repos-broken-')

    mkdirSync(join(broken, 'bad', '.git'), { recursive: true })

    const [state] = JSON.parse(repos(['--json'], broken).out) as RepoState[]

    expect(state).toMatchObject({ name: 'bad', unreadable: true })
    expect(repos([], broken).out).toContain('unreadable')
    expect(listed().every(entry => entry.unreadable === false)).toBe(true)
  })

  test('a file as root is a usage error', () => {
    const file = join(temp('repos-file-'), 'file.txt')

    writeFileSync(file, 'x\n')
    expect(repos([], file).code).toBe(2)
  })
})

describe('repos --path', () => {
  test('prints only the paths of the repositories listed, nothing else', () => {
    expect(repos(['--path', '--only', 'dirty']).out).toBe(`${join(root, 'dirty')}\n`)
    expect(repos(['--path', '--only', 'unreleased']).out.trimEnd().split('\n').toSorted()).toEqual([join(root, 'group', 'released'), join(root, 'mono')])
    expect(repos(['--path', '--json']).code).toBe(2)
  })
})

describe('repos --pull', () => {
  // Three clones of one origin, a fourth pushing two commits to it: `clean` is only behind, `dirty` has an edit, `diverged` a local commit.
  function behind() {
    const pulling = temp('repos-pull-')
    const bare = join(temp('repos-pull-origin-'), 'origin.git')

    git(pulling, 'init', '-q', '--bare', bare)

    const seed = join(temp('repos-pull-seed-'), 'seed')

    git(pulling, 'clone', '-q', bare, seed)
    commit(seed, 'seed.txt')
    git(seed, 'push', '-q', '-u', 'origin', 'main')

    for (const name of ['clean', 'dirty', 'diverged'])
      git(pulling, 'clone', '-q', bare, join(pulling, name))

    writeFileSync(join(pulling, 'dirty', 'seed.txt'), 'edited\n')
    commit(join(pulling, 'diverged'), 'mine.txt')
    commit(seed, 'one.txt')
    commit(seed, 'two.txt')
    git(seed, 'push', '-q')

    return { pulling, bare, head: (name: string) => git(join(pulling, name), 'rev-parse', 'HEAD') }
  }

  test('fast-forwards a clean repository behind, and only that one', () => {
    const { pulling, bare, head } = behind()
    const before = { dirty: head('dirty'), diverged: head('diverged') }
    const { code, out } = repos(['--pull'], pulling)
    const tip = git(bare, 'rev-parse', 'main')

    expect(code).toBe(0)
    expect(head('clean')).toBe(tip)
    expect(head('dirty')).toBe(before.dirty)
    expect(head('diverged')).toBe(before.diverged)
    expect(out).toContain('ok: clean pulled 2 commits')
    expect(out).toContain('note: dirty skipped 1 dirty file')
    expect(out).toContain('note: diverged skipped diverged, 1 ahead')
    expect(git(join(pulling, 'dirty'), 'status', '--porcelain')).toBe('M seed.txt')
  })

  test('lists a repository pulled as it now stands, and with --path keeps stdout to paths', () => {
    const { pulling } = behind()
    const listing = repos(['--pull', '--path'], pulling)

    expect(listing.out.trimEnd().split('\n').toSorted()).toEqual([join(pulling, 'dirty'), join(pulling, 'diverged')])
    expect(listing.err).toContain('clean pulled')
  })

  test('changes nothing without --pull, behind or not', () => {
    const { pulling, bare, head } = behind()

    repos(['--fetch'], pulling)
    expect(head('clean')).not.toBe(git(bare, 'rev-parse', 'main'))
  })
})
