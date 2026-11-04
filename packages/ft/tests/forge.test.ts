import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { loginHosts, remoteHost } from '../src/forge'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const root = mkdtempSync(join(tmpdir(), 'ft-forge-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function ftIn(origin: string, ...args: string[]) {
  const config = join(root, 'config')
  const repo = mkdtempSync(join(root, 'repo-'))

  mkdirSync(join(config, 'tea'), { recursive: true })
  writeFileSync(join(config, 'tea', 'config.yml'), 'logins:\n    - name: git.kaynooo.fr\n      url: https://git.kaynooo.fr\n      ssh_host: git.kaynooo.fr\n')
  Bun.spawnSync(['git', 'init', '-q', repo])
  Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', origin])

  const run = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: repo, env: { ...process.env, XDG_CONFIG_HOME: config, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })

  return { code: run.exitCode, err: run.stderr.toString() }
}

describe('remoteHost', () => {
  test('reads the host of an scp-style, ssh and https remote', () => {
    expect(remoteHost('git@git.kaynooo.fr:kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(remoteHost('ssh://git@git.kaynooo.fr:22022/kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(remoteHost('https://GitLab.com/x/y.git\n')).toBe('gitlab.com')
    expect(remoteHost('forgejo:kaynooo/cli.git')).toBe('forgejo')
    expect(remoteHost('/srv/git/cli.git')).toBeUndefined()
  })
})

describe('loginHosts', () => {
  test('collects the url and ssh_host of every login, ports dropped', () => {
    const config = 'logins:\n    - name: a\n      url: https://git.kaynooo.fr\n      ssh_host: git.kaynooo.fr\n    - name: b\n      url: http://forge.local:3000\n      ssh_host: forge.local:22\n'

    expect([...loginHosts(config)].sort()).toEqual(['forge.local', 'git.kaynooo.fr'])
  })
})

describe('a call that leaves the repository to tea', () => {
  test('exits 2 naming the origin when it is not on a Forgejo tea is logged in to', () => {
    const result = ftIn('git@gitlab.com:x/y.git', 'board')

    expect(result.code).toBe(2)
    expect(result.err).toContain('origin git@gitlab.com:x/y.git is not on a Forgejo tea is logged in to (git.kaynooo.fr)')
  })

  test('goes on to tea when the origin is on the Forgejo', () => {
    const result = ftIn('git@git.kaynooo.fr:kaynooo/cli.git', 'board')

    expect(result.err).not.toContain('is not on a Forgejo')
  })
})
