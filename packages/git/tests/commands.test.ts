import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const WHITESPACE = /\s+/
const BINS = Object.fromEntries(['gf', 'gcl', 'gd', 'gu'].map(name => [name, new URL(`../src/${name}.ts`, import.meta.url).pathname]))
// The user's global hooks and settings stay out of the test repositories.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', NO_COLOR: '1' }

let root = ''
let origin = ''
let work = ''

function run(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(argv, { cwd, env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

// For a bin talking to a server of the test's own, which a blocked event loop could not answer.
async function runAsync(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, out, err }
}

// The table pads its columns, so a test reads the words and not the spacing.
const json = <T>(text: string): T => JSON.parse(text) as T
const squeezed = (text: string) => text.trim().split(WHITESPACE).join(' ')
const git = (cwd: string, ...args: string[]) => run(['git', ...args], cwd).out.trim()
const bin = (name: string, cwd: string, ...args: string[]) => run([process.execPath, BINS[name]!, ...args], cwd)

function commit(cwd: string, name: string, text: string): void {
  writeFileSync(join(cwd, name), text)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-q', '-m', `edit ${name}`)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-git-commands-')))
  origin = join(root, 'origin')
  work = join(root, 'work')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Test')
  git(origin, 'config', 'user.email', 'test@example.com')
  commit(origin, 'a.txt', 'one\n')
  run(['git', 'clone', '-q', origin, work], root)
  git(work, 'config', 'user.name', 'Test')
  git(work, 'config', 'user.email', 'test@example.com')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('gf', () => {
  test('is up to date when nothing came in', () => {
    expect(squeezed(bin('gf', work).out)).toBe('. main up to date')
  })

  test('fast-forwards onto what the upstream gained', () => {
    commit(origin, 'b.txt', 'two\n')
    commit(origin, 'c.txt', 'three\n')

    const done = bin('gf', work)

    expect(done.out).toContain('main <- origin/main, 2 commits')
    expect(existsSync(join(work, 'c.txt'))).toBe(true)
  })

  test('--no-pull only fetches and says how far behind it is', () => {
    commit(origin, 'b.txt', 'two\n')

    expect(bin('gf', work, '--no-pull').out).toContain('main is 1 behind origin/main')
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
  })

  test('refuses a diverged branch and leaves it as it was', () => {
    commit(origin, 'b.txt', 'two\n')
    commit(work, 'w.txt', 'mine\n')
    const head = git(work, 'rev-parse', 'HEAD')

    const done = bin('gf', work, '--json')

    expect(done.code).toBe(1)
    expect(json<unknown[]>(done.out)[0]).toMatchObject({ outcome: 'refused', reason: 'diverged: 1 ahead, 1 behind, nothing merged' })
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('refuses a fast-forward that would overwrite local changes', () => {
    commit(origin, 'a.txt', 'changed upstream\n')
    writeFileSync(join(work, 'a.txt'), 'changed here\n')

    const done = bin('gf', work, '--json')

    expect(done.code).toBe(1)
    expect(json<unknown[]>(done.out)[0]).toMatchObject({ outcome: 'refused', reason: 'uncommitted changes in files the fast-forward changes (a.txt): commit them first (gc), or set them aside as a patch (gu)' })
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('changed here\n')
  })

  test('names the untracked files a fast-forward would overwrite', () => {
    commit(origin, 'b.txt', 'upstream\n')
    writeFileSync(join(work, 'b.txt'), 'mine\n')

    const done = bin('gf', work, '--json')

    expect(json<unknown[]>(done.out)[0]).toMatchObject({ outcome: 'refused', reason: 'untracked files the fast-forward would overwrite (b.txt): move them aside first' })
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('mine\n')
  })

  test('fetches only a branch with no upstream', () => {
    git(work, 'switch', '-q', '-c', 'topic')

    expect(bin('gf', work).out).toContain('topic no upstream, fetched only')
  })

  test('outside a repository it is a usage error', () => {
    expect(bin('gf', root).code).toBe(2)
  })
})

describe('gcl', () => {
  test('clones into the given folder and prints its path', () => {
    const target = join(root, 'cloned')
    const done = bin('gcl', root, origin, target)

    expect(done.code).toBe(0)
    expect(done.out).toBe(`${target}\n`)
    expect(done.err).toContain('cloned')
    expect(existsSync(join(target, 'a.txt'))).toBe(true)
  })

  test('clones into ./<name> by default, as git clone does', () => {
    const here = join(root, 'here')

    mkdirSync(here)
    const done = run([process.execPath, BINS.gcl!, origin, '--json'], here, { KAYNOOO_WORKSPACE: join(root, 'space') })

    expect(done.code).toBe(0)
    expect(JSON.parse(done.out)).toMatchObject({ path: join(here, 'origin'), outcome: 'cloned' })
    expect(existsSync(join(here, 'origin', 'a.txt'))).toBe(true)
  })

  test('brings an existing clone up to date instead of cloning again', () => {
    commit(origin, 'b.txt', 'two\n')
    const done = bin('gcl', root, origin, work, '--json')

    expect(JSON.parse(done.out)).toMatchObject({ outcome: 'existing', path: work })
    expect(existsSync(join(work, 'b.txt'))).toBe(true)
  })

  test('refuses a folder that is a clone of another repository', () => {
    const done = bin('gcl', root, join(root, 'elsewhere'), work)

    expect(done.code).toBe(1)
    expect(done.err).toContain('not')
  })

  test('refuses a folder holding something else', () => {
    const taken = join(root, 'taken')

    mkdirSync(taken)
    writeFileSync(join(taken, 'f'), 'x')

    const done = bin('gcl', root, origin, taken)

    expect(done.code).toBe(1)
    expect(done.err).toContain('is not a repository')
    expect(readdirSync(taken)).toEqual(['f'])
  })

  // A forge refusing every anonymous clone as Forgejo does a private repository, owner/name read on it through the config.
  function privateForge(config: Record<string, string>) {
    const server = Bun.serve({ port: 0, fetch: () => new Response('login needed', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="forge"' } }) })
    const home = join(root, 'config')
    const marker = join(root, 'asked')
    const asker = join(root, 'asker')

    mkdirSync(join(home, 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(home, 'kaynooo-cli', 'config.json'), JSON.stringify({ forge: `http://127.0.0.1:${server.port}`, ...config }))
    // Stands for the desktop's password window: it must never open.
    writeFileSync(asker, `#!/bin/sh\ntouch ${marker}\necho secret\n`, { mode: 0o755 })

    return { server, marker, env: { XDG_CONFIG_HOME: home, GIT_ASKPASS: asker, SSH_ASKPASS: asker, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' } }
  }

  test('off a terminal a private owner/name opens no password window and names the ssh address', async () => {
    const forge = privateForge({})

    try {
      const done = await runAsync([process.execPath, BINS.gcl!, 'kaynooo/secret', join(root, 'secret')], root, forge.env)

      expect(done.code).toBe(1)
      expect(done.err).toContain('kaynooo/secret may be private')
      expect(done.err).toContain('gcl git@127.0.0.1:kaynooo/secret.git')
      expect(existsSync(forge.marker)).toBe(false)
    }
    finally {
      void forge.server.stop(true)
    }
  })

  test('a private owner/name is cloned over ssh from the forgeSsh address', async () => {
    const forge = privateForge({ forgeSsh: `${root}/` })

    mkdirSync(join(root, 'kaynooo'))
    run(['git', 'clone', '-q', '--bare', origin, join(root, 'kaynooo', 'secret.git')], root)

    try {
      const done = await runAsync([process.execPath, BINS.gcl!, 'kaynooo/secret', join(root, 'secret'), '--json'], root, forge.env)

      expect(done.code).toBe(0)
      expect(JSON.parse(done.out)).toMatchObject({ url: `${root}/kaynooo/secret.git`, outcome: 'cloned' })
      expect(existsSync(join(root, 'secret', 'a.txt'))).toBe(true)
      expect(existsSync(forge.marker)).toBe(false)

      // run again, the ssh clone is the same repository as owner/name
      expect(JSON.parse((await runAsync([process.execPath, BINS.gcl!, 'kaynooo/secret', join(root, 'secret'), '--json'], root, forge.env)).out)).toMatchObject({ outcome: 'existing' })
    }
    finally {
      void forge.server.stop(true)
    }
  })

  test('an owner/name ssh cannot reach is cloned anonymously over https', () => {
    const home = join(root, 'config')

    mkdirSync(join(home, 'kaynooo-cli'), { recursive: true })
    mkdirSync(join(root, 'public', 'kaynooo'), { recursive: true })
    run(['git', 'clone', '-q', '--bare', origin, join(root, 'public', 'kaynooo', 'open.git')], root)
    writeFileSync(join(home, 'kaynooo-cli', 'config.json'), JSON.stringify({ forge: `file://${root}/public`, forgeSsh: `${root}/nowhere/` }))

    const done = run([process.execPath, BINS.gcl!, 'kaynooo/open', join(root, 'open'), '--json'], root, { XDG_CONFIG_HOME: home })

    expect(done.code).toBe(0)
    expect(JSON.parse(done.out)).toMatchObject({ url: `file://${root}/public/kaynooo/open.git`, outcome: 'cloned' })
    expect(existsSync(join(root, 'open', 'a.txt'))).toBe(true)
  })

  test('refuses owner/name when the config names no forge', () => {
    const home = join(root, 'empty-config')

    mkdirSync(home)

    const done = run([process.execPath, BINS.gcl!, 'kaynooo/open', join(root, 'open')], root, { XDG_CONFIG_HOME: home })

    expect(done.code).toBe(2)
    expect(done.err).toContain(`set forge (a host such as git.example.org) in ${home}/kaynooo-cli/config.json`)
    expect(existsSync(join(root, 'open'))).toBe(false)
  })

  test('reads owner/name as a URL on the forge, and its ssh address', async () => {
    const { urlOf, nameOf, sshUrlOf } = await import('../src/gcl')

    expect(sshUrlOf('kaynooo/cli', 'git@git.example.org')).toBe('git@git.example.org:kaynooo/cli.git')
    expect(sshUrlOf('kaynooo/cli.git', 'ssh://git@git.example.org:22022')).toBe('ssh://git@git.example.org:22022/kaynooo/cli.git')
    expect(urlOf('kaynooo/cli', 'http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/kaynooo/cli.git')
    expect(urlOf('kaynooo/cli', 'git.example.org')).toBe('https://git.example.org/kaynooo/cli.git')
    expect(urlOf('git@github.com:oven-sh/bun.git', 'x')).toBe('git@github.com:oven-sh/bun.git')
    expect(urlOf('git@git.example.org:22022:kaynooo/cli.git', 'x')).toBe('ssh://git@git.example.org:22022/kaynooo/cli.git')
    expect(nameOf('git@github.com:oven-sh/bun.git')).toBe('bun')
    expect(nameOf('https://git.example.org/kaynooo/cli.git')).toBe('cli')
  })
})

describe('gd', () => {
  test('lists staged apart from unstaged with their lines', () => {
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
    git(work, 'add', 'a.txt')
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\nthree\n')

    const done = bin('gd', work)

    expect(squeezed(done.out)).toBe('staged a.txt +1 -0 unstaged a.txt +1 -0')
  })

  test('says so when nothing tracked changed, and prints the patch of the paths given', () => {
    expect(bin('gd', work).out).toBe('no change in the tracked files\n')

    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')

    expect(bin('gd', work, 'a.txt').out).toContain('+two')
  })

  test('--stat lists the paths given without their patch', () => {
    commit(work, 'other.txt', 'x\n')
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(work, 'other.txt'), 'y\n')

    expect(squeezed(bin('gd', work, '--stat', 'a.txt').out)).toBe('unstaged a.txt +1 -0')
    expect(bin('gd', work, '--stat', '--patch').code).toBe(2)
  })

  test('--json with a path gives the files and the patch of that path as JSON', () => {
    commit(work, 'other.txt', 'x\n')
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(work, 'other.txt'), 'y\n')

    const sections = JSON.parse(bin('gd', work, 'a.txt', '--json').out) as { title: string, files: { path: string, added: number, removed: number }[], patch: string }[]
    const unstaged = sections.find(section => section.files.length > 0)

    expect(unstaged?.files).toEqual([{ path: 'a.txt', added: 1, removed: 0 }])
    expect(unstaged?.patch).toContain('+two')
  })

  test('--ref takes no option-looking value and not --staged', () => {
    expect(bin('gd', work, '--ref=--output=x').code).toBe(2)
    expect(bin('gd', work, '--ref', 'HEAD', '--staged').code).toBe(2)
    expect(existsSync(join(work, 'x'))).toBe(false)
  })

  test('--ref compares the working tree to a commit', () => {
    commit(work, 'b.txt', 'two\n')

    expect(JSON.parse(bin('gd', work, '--ref', 'HEAD~1', '--json').out)).toEqual([{ title: 'against HEAD~1', files: [{ path: 'b.txt', added: 1, removed: 0 }] }])
  })
})

describe('gu', () => {
  test('discards unstaged changes after saving them as a patch that puts them back', () => {
    writeFileSync(join(work, 'a.txt'), 'one\nlost?\n')

    const done = bin('gu', work, 'a.txt', '--json')
    const { saved } = json<{ saved: string }>(done.out)

    expect(done.code).toBe(0)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\n')
    expect(run(['git', 'apply', saved], work).code).toBe(0)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nlost?\n')
  })

  test('takes an intent-to-add file out of the index and off the disk, so its patch puts it back', () => {
    mkdirSync(join(work, 'sub'))
    writeFileSync(join(work, 'sub', 'new.txt'), 'new\n')
    git(work, 'add', '-N', 'sub/new.txt')
    writeFileSync(join(work, 'a.txt'), 'one\nlost?\n')

    const done = bin('gu', join(work, 'sub'), 'new.txt', '../a.txt', '--json')
    const { saved } = json<{ saved: string }>(done.out)

    expect(done.code).toBe(0)
    expect(existsSync(join(work, 'sub', 'new.txt'))).toBe(false)
    expect(git(work, 'status', '--porcelain')).toBe('')
    expect(run(['git', 'apply', saved], work).code).toBe(0)
    expect(readFileSync(join(work, 'sub', 'new.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nlost?\n')
  })

  test('saves a patch git apply takes whatever the diff config says', () => {
    for (const [key, value] of Object.entries({ 'diff.external': 'echo side by side view', 'color.diff': 'always', 'diff.noprefix': 'true', 'diff.relative': 'true', 'diff.view.textconv': 'tr a-z A-Z' }))
      git(work, 'config', key, value)

    writeFileSync(join(work, '.gitattributes'), 'a.txt diff=view\n')
    writeFileSync(join(work, 'a.txt'), 'one\nlost?\n')

    const { saved } = json<{ saved: string }>(bin('gu', work, 'a.txt', '--json').out)

    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\n')
    expect(run(['git', 'apply', saved], work).code).toBe(0)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nlost?\n')
  })

  // A git whose apply refuses stands in for a patch that does not hold the change, which the flags above leave no config to cause.
  test('discards nothing when the saved patch would not put the change back', () => {
    const stubs = join(root, 'stubs')
    const real = Bun.which('git')!

    mkdirSync(stubs)
    writeFileSync(join(stubs, 'git'), `#!/bin/sh\nfor arg; do [ "$arg" = apply ] && { echo 'error: corrupt patch' >&2; exit 1; }; done\nexec ${real} "$@"\n`, { mode: 0o755 })
    writeFileSync(join(work, 'a.txt'), 'one\nkept\n')

    const done = run([process.execPath, BINS.gu!, 'a.txt'], work, { PATH: `${stubs}:${process.env.PATH}` })

    expect(done.code).toBe(1)
    expect(done.err).toContain('would not put the change back')
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nkept\n')
  })

  test('--staged works before the first commit', () => {
    const fresh = join(root, 'fresh')

    mkdirSync(fresh)
    git(fresh, 'init', '-q', '-b', 'main')
    writeFileSync(join(fresh, 'n.txt'), 'new\n')
    git(fresh, 'add', 'n.txt')

    expect(bin('gu', fresh, '--staged', 'n.txt').out).toBe('unstaged n.txt\n')
    expect(git(fresh, 'diff', '--cached', '--name-only')).toBe('')
    expect(readFileSync(join(fresh, 'n.txt'), 'utf8')).toBe('new\n')
  })

  test('--staged unstages and keeps the working tree', () => {
    writeFileSync(join(work, 'a.txt'), 'one\nmore\n')
    git(work, 'add', 'a.txt')

    expect(bin('gu', work, '--staged', 'a.txt').out).toBe('unstaged a.txt\n')
    expect(git(work, 'diff', '--cached', '--name-only')).toBe('')
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nmore\n')
  })

  test('needs a path and refuses one with no change', () => {
    expect(bin('gu', work).code).toBe(2)
    expect(bin('gu', work, 'a.txt').code).toBe(1)
  })

  test('a path with no change next to a real one discards nothing', () => {
    writeFileSync(join(work, 'a.txt'), 'one\nkept\n')

    const done = bin('gu', work, 'a.txt', 'typo.txt')

    expect(done.code).toBe(1)
    expect(done.err).toContain('typo.txt')
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('one\nkept\n')
    expect(existsSync(join(work, '.git', 'gu'))).toBe(false)
  })

  test('--commit undoes an unpushed commit keeping its changes staged', () => {
    commit(work, 'b.txt', 'two\n')

    const done = bin('gu', work, '--commit')

    expect(done.code).toBe(0)
    expect(git(work, 'diff', '--cached', '--name-only')).toBe('b.txt')
    expect(git(work, 'log', '-1', '--format=%s')).toBe('edit a.txt')
  })

  test('--commit refuses a commit the upstream holds', () => {
    const done = bin('gu', work, '--commit')

    expect(done.code).toBe(1)
    expect(done.err).toContain('already on the upstream')
  })
})
