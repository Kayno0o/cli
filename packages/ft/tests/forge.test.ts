import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { loginHosts, originHost } from '../src/forge'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const root = mkdtempSync(join(tmpdir(), 'ft-forge-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function ftIn(origin: string, ...args: string[]) {
  return ftWith(origin, 'logins:\n    - name: git.kaynooo.fr\n      url: "https://git.kaynooo.fr"\n      ssh_host: git.kaynooo.fr\n', ...args)
}

function ftWith(origin: string, teaConfig: string | undefined, ...args: string[]) {
  const config = mkdtempSync(join(root, 'config-'))
  const repo = mkdtempSync(join(root, 'repo-'))

  mkdirSync(join(config, 'tea'), { recursive: true })

  if (teaConfig !== undefined)
    writeFileSync(join(config, 'tea', 'config.yml'), teaConfig)

  Bun.spawnSync(['git', 'init', '-q', repo])
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', origin])

  const run = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: repo, env: { ...process.env, XDG_CONFIG_HOME: config, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })

  return { code: run.exitCode, err: run.stderr.toString() }
}

describe('originHost', () => {
  test('reads the host of an scp-style, ssh and https remote', () => {
    expect(originHost('git@git.kaynooo.fr:kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(originHost('ssh://git@git.kaynooo.fr:22022/kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(originHost('https://GitLab.com/x/y.git\n')).toBe('gitlab.com')
    expect(originHost('forgejo:kaynooo/cli.git')).toBe('forgejo')
    expect(originHost('/srv/git/cli.git')).toBeUndefined()
  })
})

describe('loginHosts', () => {
  test('collects the url and ssh_host of every login, ports dropped', () => {
    const config = 'logins:\n    - name: a\n      url: https://git.kaynooo.fr\n      ssh_host: git.kaynooo.fr\n    - name: b\n      url: http://forge.local:3000\n      ssh_host: forge.local:22\n'

    expect([...loginHosts(config)].sort()).toEqual(['forge.local', 'git.kaynooo.fr'])
  })
})

describe('a call that leaves the repository to tea', () => {
  test('exits 2 naming the origin when it is not on a Forgejo you are logged in to', () => {
    const result = ftIn('git@gitlab.com:x/y.git', 'board')

    expect(result.code).toBe(2)
    expect(result.err).toContain('origin git@gitlab.com:x/y.git is not on a Forgejo you are logged in to (git.kaynooo.fr)')
  })

  test('keeps a token in the origin out of the message', () => {
    const result = ftIn('https://me:secret@gitlab.com/x/y.git', 'board')

    expect(result.code).toBe(2)
    expect(result.err).not.toContain('secret')
  })

  test('also guards the issue writes that go straight to tea, and a --repo skips it', () => {
    expect(ftIn('git@gitlab.com:x/y.git', 'edit', '1', '-t', 'new').code).toBe(2)
    expect(ftIn('git@gitlab.com:x/y.git', 'board', '-r', 'kaynooo/cli').err).not.toContain('is not on a Forgejo')
  })

  test('says nothing without a tea config', () => {
    expect(ftWith('git@gitlab.com:x/y.git', undefined, 'board').err).not.toContain('is not on a Forgejo')
  })

  test('goes on to tea when the origin is on the Forgejo', () => {
    const result = ftIn('git@git.kaynooo.fr:kaynooo/cli.git', 'board')

    expect(result.err).not.toContain('is not on a Forgejo')
  })
})
