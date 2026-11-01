import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const GST = new URL('../src/gst.ts', import.meta.url).pathname
const GC = new URL('../src/gc.ts', import.meta.url).pathname
// The user's global hooks and settings stay out of the test repositories.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

let dir = ''

function run(argv: string[]) {
  const result = Bun.spawnSync(argv, { cwd: dir, env: ENV, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

const git = (...args: string[]) => run(['git', ...args]).out.trim()
const gst = (...args: string[]) => run([process.execPath, GST, ...args])
const gc = (...args: string[]) => run([process.execPath, GC, ...args])

function file(name: string, text = `${name}\n`): void {
  writeFileSync(join(dir, name), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'git-tools-test-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
})

describe('gst', () => {
  test('prints its version and its help', () => {
    expect(gst('--version').out.trim()).toBe(version)
    expect(gst('--help').out).toContain('gst [--log N]')
  })

  test('a repository without commits', () => {
    expect(gst().out).toBe('branch `main`, no upstream; 0 changed files; no commit yet\n')
  })

  test('the summary line, then the paths by staged, unstaged and untracked, and the last commits', () => {
    file('a.ts')
    file('b.ts')
    git('add', 'a.ts', 'b.ts')
    git('commit', '-q', '-m', 'feat: first')
    git('mv', 'a.ts', 'c.ts')
    file('b.ts', 'changed\n')
    file('new.ts')
    const sha = git('rev-parse', '--short', 'HEAD')

    expect(gst('--log', '1').out).toBe([
      `branch \`main\`, no upstream; 2 changed, 1 untracked files; HEAD ${sha} feat: first`,
      'staged:',
      '  R a.ts -> c.ts',
      'unstaged:',
      '  M b.ts',
      'untracked:',
      '  new.ts',
      'commits:',
      `  ${sha} feat: first`,
      '',
    ].join('\n'))
    expect(JSON.parse(gst('--log', '1', '--json').out)).toEqual({
      branch: 'main',
      oid: git('rev-parse', 'HEAD'),
      upstream: null,
      ahead: null,
      behind: null,
      head: { sha, title: 'feat: first' },
      staged: [{ status: 'R', path: 'c.ts', from: 'a.ts' }],
      unstaged: [{ status: 'M', path: 'b.ts' }],
      untracked: ['new.ts'],
      conflicted: [],
      commits: [{ sha, title: 'feat: first' }],
    })
  })

  test('outside a repository it says so', () => {
    rmSync(join(dir, '.git'), { recursive: true })
    const result = gst()

    expect(result.code).toBe(1)
    expect(result.err).toContain('not a git repository')
  })
})

describe('gc', () => {
  beforeEach(() => {
    file('base.ts')
    git('add', 'base.ts')
    git('commit', '-q', '-m', 'chore: base')
  })

  test('commits exactly the paths given, its message built from the title, lines and tickets', () => {
    file('a.ts')
    file('b.ts')
    file('base.ts', 'changed\n')
    const result = gc('feat(x): add a', '-m', 'Adds a beside base.', '--ticket', '#12 - [UC3] Ajouter a', '--', 'a.ts', 'base.ts')
    const sha = git('rev-parse', '--short', 'HEAD')

    expect(result.code).toBe(0)
    expect(result.out).toBe(`${sha} feat(x): add a\n  A a.ts\n  M base.ts\n`)
    expect(git('log', '-1', '--format=%B')).toBe('feat(x): add a\n\nAdds a beside base.\n\n#12 - [UC3] Ajouter a')
    expect(git('status', '--porcelain')).toBe('?? b.ts')
  })

  test('commits a deletion and a path in a subdirectory', () => {
    mkdirSync(join(dir, 'sub'))
    file('sub/x.ts')
    rmSync(join(dir, 'base.ts'))
    const result = gc('chore: move', '--', 'base.ts', 'sub')

    expect(result.code).toBe(0)
    expect(result.out).toEndWith('  D base.ts\n  A sub/x.ts\n')
  })

  test('refuses a message breaking a rule, naming it, with nothing staged', () => {
    file('a.ts')
    const result = gc('Added a', '--', 'a.ts')

    expect(result.code).toBe(1)
    expect(result.err).toContain('nothing staged: The title is no Conventional Commit. The rule: a `type(scope): title` line')
    expect(gc('fix: a', '-m', 'One.', '-m', 'Two.', '-m', 'Three.', '--', 'a.ts').err).toContain('at most two lines')
    expect(gc('fix: a', '--ticket', 'UC3 Ajouter a', '--', 'a.ts').err).toContain('a ticket line reads')
    expect(git('status', '--porcelain')).toBe('?? a.ts')
  })

  test('refuses a path without a change, and an index holding other staged files', () => {
    file('a.ts')
    file('b.ts')

    expect(gc('fix: a', '--', 'a.ts', 'base.ts').err).toContain('no change to commit in base.ts')
    expect(gc('fix: a', '--', 'a.ts', 'base.ts').err).toContain('hint: run `gst` to see what changed')

    git('add', 'b.ts')
    const result = gc('fix: a', '--', 'a.ts')

    expect(result.code).toBe(1)
    expect(result.err).toContain('the index already holds b.ts')
    expect(result.err).toContain('hint: run `git restore --staged -- b.ts` to unstage them')
    expect(git('status', '--porcelain')).toBe('A  b.ts\n?? a.ts')
  })

  test('commits a path that was already staged on its own', () => {
    file('a.ts')
    git('add', 'a.ts')

    expect(gc('fix: a', '--', 'a.ts').code).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
  })

  test('unstages the paths again when git refuses the commit', () => {
    mkdirSync(join(dir, '.git/hooks'), { recursive: true })
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 })
    file('a.ts')
    const result = gc('fix: a', '--', 'a.ts')

    expect(result.code).toBe(1)
    expect(result.err).toContain('git commit failed, the paths were unstaged')
    expect(git('status', '--porcelain')).toBe('?? a.ts')
  })

  test('asks for one quoted title and the paths after --', () => {
    expect(gc('fix:', 'a', '--', 'a.ts').err).toContain('give the title as one quoted argument')
    expect(gc('fix: a').err).toContain('give the paths to commit after --')
  })
})
