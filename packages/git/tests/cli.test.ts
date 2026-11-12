import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const GST = new URL('../src/gst.ts', import.meta.url).pathname
const GC = new URL('../src/gc.ts', import.meta.url).pathname
const GB = new URL('../src/gb.ts', import.meta.url).pathname
// The user's global hooks and settings stay out of the test repositories.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

let dir = ''

function run(argv: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(argv, { cwd: dir, env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

const git = (...args: string[]) => run(['git', ...args]).out.trim()
const gst = (...args: string[]) => run([process.execPath, GST, ...args])
const gc = (...args: string[]) => run([process.execPath, GC, ...args])
const gb = (...args: string[]) => run([process.execPath, GB, ...args])

function file(name: string, text = `${name}\n`): void {
  writeFileSync(join(dir, name), text)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-git-test-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('gst', () => {
  test('prints its version and its help', () => {
    expect(gst('--version').out.trim()).toBe(version)
    expect(gst('--help').out).toContain('gst [-n N]')
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
      operation: null,
      stash: 0,
      commits: [{ sha, title: 'feat: first' }],
    })
  })

  test('counts the stash and says which operation is in progress', () => {
    file('a.ts', 'base\n')
    git('add', 'a.ts')
    git('commit', '-q', '-m', 'feat: base')
    git('checkout', '-q', '-b', 'topic')
    file('a.ts', 'topic\n')
    git('commit', '-q', '-am', 'feat: topic')
    git('checkout', '-q', 'main')
    file('a.ts', 'main\n')
    git('commit', '-q', '-am', 'feat: main')
    file('b.ts')
    git('add', 'b.ts')
    git('stash', '-q')

    expect(gst().out).toContain('files; 1 stashed; HEAD')
    expect(JSON.parse(gst('--json').out)).toMatchObject({ operation: null, stash: 1 })

    git('checkout', '-q', 'topic')
    git('rebase', 'main')

    expect(gst().out).toStartWith('detached at')
    expect(gst().out).toContain('(rebase 1/1 in progress)')
    expect(JSON.parse(gst('--json').out)).toMatchObject({ operation: { kind: 'rebase', step: 1, total: 1 } })

    git('rebase', '--abort')
    git('merge', 'main')

    expect(gst().out).toContain('branch `topic` (merge in progress)')
    expect(JSON.parse(gst('--json').out)).toMatchObject({ operation: { kind: 'merge' } })
  })

  test('-n and --limit add the last commits, --log and -l are the former spellings of it', () => {
    file('a.ts')
    git('add', 'a.ts')
    git('commit', '-q', '-m', 'feat: first')

    const sha = git('rev-parse', '--short', 'HEAD')
    const shown = `commits:\n  ${sha} feat: first\n`

    for (const flags of [['-n', '1'], ['--limit', '1'], ['--log', '1'], ['-l', '1']])
      expect(gst(...flags).out).toContain(shown)

    expect(gst('-n', '1', '--log', '1').code).toBe(2)
  })

  test('outside a repository it says so', () => {
    rmSync(join(dir, '.git'), { recursive: true })
    const result = run([process.execPath, GST], { GIT_CEILING_DIRECTORIES: dirname(realpathSync(dir)) })

    expect(result.code).toBe(2)
    expect(result.err).toContain('not a git repository')
  })
})

describe('gb', () => {
  test('--json words a branch\'s last commit through formatAge', () => {
    file('a.ts')
    git('add', 'a.ts')
    git('commit', '-q', '-m', 'feat: first')
    git('branch', 'other')

    const [first] = JSON.parse(gb('--json').out) as { name: string, when: string }[]

    expect(first).toMatchObject({ name: 'other', when: 'just now' })
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

  test('--quiet commits and prints nothing', () => {
    file('a.ts')

    const result = gc('feat(x): add a', '-q', '--', 'a.ts')

    expect(result).toMatchObject({ code: 0, out: '', err: '' })
    expect(git('log', '-1', '--format=%s')).toBe('feat(x): add a')
  })

  test('--json prints the sha, subject and files of the commit, a rename with its old path', () => {
    file('a.ts')
    git('mv', 'base.ts', 'moved.ts')

    const result = gc('feat(x): add a', '--json', '--', 'a.ts', 'base.ts', 'moved.ts')

    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ sha: git('rev-parse', 'HEAD'), subject: 'feat(x): add a', files: [{ status: 'A', path: 'a.ts' }, { status: 'R', path: 'moved.ts', from: 'base.ts' }] })
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

  test('commits both sides of a git mv, the old path already staged as deleted', () => {
    git('mv', 'base.ts', 'moved.ts')
    const result = gc('refactor: move base', '--', 'base.ts', 'moved.ts')

    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toEndWith('  R base.ts -> moved.ts\n')
    expect(git('status', '--porcelain')).toBe('')
  })

  test('given only the new side of a git mv, commits the old side with it', () => {
    git('mv', 'base.ts', 'moved.ts')
    const result = gc('refactor: move base', '--', 'moved.ts')

    expect(result).toMatchObject({ code: 0, err: '' })
    expect(result.out).toContain('  R base.ts -> moved.ts\n')
    expect(result.out).toContain('also committed base.ts')
    expect(git('status', '--porcelain')).toBe('')
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
    expect(result.err).toContain('git commit failed, the index was put back as it was')
    expect(git('status', '--porcelain')).toBe('?? a.ts')
  })

  test('a refused commit leaves what was staged on a path before staged', () => {
    mkdirSync(join(dir, '.git/hooks'), { recursive: true })
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    file('base.ts', 'staged\n')
    git('add', 'base.ts')
    file('base.ts', 'worktree\n')

    expect(gc('fix: base', '--', 'base.ts').code).toBe(1)
    expect(git('show', ':base.ts')).toBe('staged')
    expect(git('status', '--porcelain')).toBe('MM base.ts')
  })

  test('refuses a merge in progress before staging, its resolution left as it was', () => {
    git('checkout', '-q', '-b', 'feat')
    file('base.ts', 'feat\n')
    git('commit', '-q', '-am', 'feat')
    git('checkout', '-q', 'main')
    file('base.ts', 'main\n')
    git('commit', '-q', '-am', 'main')
    git('merge', 'feat')
    file('base.ts', 'resolved\n')
    const result = gc('fix: resolve', '--', 'base.ts')

    expect(result.code).toBe(1)
    expect(result.err).toContain('nothing staged: a merge is in progress, which git commits only whole')
    expect(result.err).toContain('hint: run `gm --continue` to finish a merge')
    expect(git('status', '--porcelain')).toBe('UU base.ts')
  })

  test.each([['CHERRY_PICK_HEAD', 'a cherry-pick', 'git cherry-pick --continue'], ['REVERT_HEAD', 'a revert', 'git revert --continue']])('refuses while %s is set, naming what finishes it', (ref, what, finish) => {
    writeFileSync(join(dir, '.git', ref), `${git('rev-parse', 'HEAD')}\n`)
    file('base.ts', 'changed\n')
    const result = gc('fix: base', '--', 'base.ts')

    expect(result.code).toBe(1)
    expect(result.err).toContain(`nothing staged: ${what} is in progress`)
    expect(result.err).toContain(`hint: run \`${finish}\` to finish ${what}`)
    expect(git('status', '--porcelain')).toBe('M base.ts')
  })

  test('commits the old side of a rename given the new one by an absolute path through a link', () => {
    git('mv', 'base.ts', 'moved.ts')
    symlinkSync(dir, `${dir}-link`)

    try {
      expect(gc('refactor: move base', '--', join(`${dir}-link`, 'moved.ts')).code).toBe(0)
      expect(git('status', '--porcelain')).toBe('')
    }
    finally {
      rmSync(`${dir}-link`)
    }
  })

  test('from a subfolder, or given a folder, commits the old side of a rename too', () => {
    mkdirSync(join(dir, 'sub'))
    file('sub/old.ts')
    git('add', 'sub/old.ts')
    git('commit', '-q', '-m', 'chore: old')
    git('mv', 'sub/old.ts', 'sub/new.ts')
    const fromSub = Bun.spawnSync([process.execPath, GC, 'refactor: rename', '--', 'new.ts'], { cwd: join(dir, 'sub'), env: ENV, stdout: 'pipe', stderr: 'pipe' })

    expect(fromSub.exitCode).toBe(0)
    expect(fromSub.stdout.toString()).toContain('also committed old.ts')
    expect(git('status', '--porcelain')).toBe('')

    git('mv', 'base.ts', 'sub/base2.ts')

    expect(gc('refactor: move base', '--', 'sub/').code).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
  })

  test('a hook globbing the index still sees the new file, the literal pathspecs staying out of its environment', () => {
    mkdirSync(join(dir, '.git/hooks'), { recursive: true })
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\ngit ls-files --error-unmatch -- "sub/*.fish" >/dev/null || { echo "sub/new.fish is not in the index" >&2; exit 1; }\n', { mode: 0o755 })
    mkdirSync(join(dir, 'sub'))
    file('sub/new.fish')
    file('base.ts', 'changed\n')
    const result = gc('feat: add new', '--', 'sub/new.fish', 'base.ts')

    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
  })

  test('takes a path with glob characters literally, committing nothing else', () => {
    file('a[1].ts')
    file('a1.ts')
    const result = gc('fix: a', '--', 'a[1].ts')

    expect(result.code).toBe(0)
    expect(git('status', '--porcelain')).toBe('?? a1.ts')
  })

  test('outside a repository it exits 2', () => {
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    file('a.ts')

    // a ceiling at the temp folder's parent keeps any repository above it from answering, wherever the runner keeps one
    const result = run([process.execPath, GC, 'fix: a', '--', 'a.ts'], { GIT_CEILING_DIRECTORIES: dirname(realpathSync(dir)) })

    expect({ code: result.code, err: result.err }).toMatchObject({ code: 2 })
  })

  test('asks for one quoted title and the paths after --', () => {
    expect(gc('fix:', 'a', '--', 'a.ts').err).toContain('give the title as one quoted argument')
    expect(gc('fix: a').err).toContain('give the paths to commit after --')
  })
})
