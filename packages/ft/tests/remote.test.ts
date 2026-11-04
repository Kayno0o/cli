import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { limits, proveOrigin, remote } from '../src/commands/remote'
import { loadSettings, settingsPath } from '../src/config'
import { canonicalRemote, parseSshRemote, reachesHost, redactUrl } from '../src/remote'

const temp = tempDirs()

const HOST = 'git.kaynooo.fr'
const reaches = (alias: string) => alias === 'forgejo' || alias === 'gitea'

describe('canonicalRemote', () => {
  test('switches an alias remote, in every spelling, to git@<host>:<owner>/<repo>.git', () => {
    for (const url of ['forgejo:kaynooo/kayjs.git', 'git@forgejo:kaynooo/kayjs.git', 'gitea:kaynooo/kayjs', 'ssh://git@forgejo/kaynooo/kayjs.git', 'ssh://git@forgejo:22/kaynooo/kayjs/'])
      expect(canonicalRemote(url, HOST, reaches)).toBe('git@git.kaynooo.fr:kaynooo/kayjs.git')
  })

  test('keeps a port other than 22, which only the URL form carries', () => {
    expect(canonicalRemote('ssh://git@forgejo:22022/kaynooo/kayjs/', HOST, reaches)).toBe('ssh://git@git.kaynooo.fr:22022/kaynooo/kayjs.git')
  })

  test('drops a token written after the user', () => {
    expect(canonicalRemote('ssh://git:s3cret@forgejo/kaynooo/kayjs.git', HOST, reaches)).toBe('git@git.kaynooo.fr:kaynooo/kayjs.git')
  })

  test('leaves the host itself, another host and an https remote alone', () => {
    for (const url of ['git@git.kaynooo.fr:kaynooo/kayjs.git', 'ssh://git@git.kaynooo.fr/kaynooo/kayjs.git', 'git@github.com:Kayno0o/kayjs.git', 'https://git.kaynooo.fr/kaynooo/kayjs.git'])
      expect(canonicalRemote(url, HOST, reaches)).toBeUndefined()
  })
})

describe('parseSshRemote', () => {
  test('reads user, host and path, and no https URL', () => {
    expect(parseSshRemote('deploy@forgejo:a/b.git')).toEqual({ user: 'deploy', host: 'forgejo', path: 'a/b' })
    expect(parseSshRemote('https://git.kaynooo.fr/a/b.git')).toBeUndefined()
  })

  test('refuses a host ssh would read as an option', () => {
    expect(parseSshRemote('-oProxyCommand=x:a/b.git')).toBeUndefined()
    expect(parseSshRemote('ssh://-oProxyCommand=x/a/b.git')).toBeUndefined()
  })
})

describe('redactUrl', () => {
  test('strips the user and token of a URL, and leaves one without', () => {
    expect(redactUrl('https://user:tok3n@git.kaynooo.fr/a/b.git')).toBe('https://git.kaynooo.fr/a/b.git')
    expect(redactUrl('git@git.kaynooo.fr:a/b.git')).toBe('git@git.kaynooo.fr:a/b.git')
  })
})

describe('reachesHost', () => {
  const hostAddresses = new Set(['192.168.1.20'])
  const dns = new Map([['home-server', ['192.168.1.20']], ['github.com', ['140.82.121.4']]])
  const addressesOf = async (name: string) => dns.get(name) ?? [name]

  test('reaches the host by its name, its LAN IP, or a name resolving to that IP', async () => {
    for (const hostname of [HOST, '192.168.1.20', 'home-server'])
      expect(await reachesHost(hostname, HOST, hostAddresses, addressesOf)).toBe(true)
  })

  test('does not reach it from another host, nor from an alias ssh does not know', async () => {
    expect(await reachesHost('github.com', HOST, hostAddresses, addressesOf)).toBe(false)
    expect(await reachesHost(undefined, HOST, hostAddresses, addressesOf)).toBe(false)
  })
})

describe('the remote host setting', () => {
  function homeWith(text?: string): string {
    const home = temp('ft-home-')

    if (text !== undefined) {
      mkdirSync(join(home, '.config', 'ft'), { recursive: true })
      writeFileSync(settingsPath(home), text)
    }

    return home
  }

  test('comes from ~/.config/ft/config.json, and from nowhere else', async () => {
    expect(await loadSettings(homeWith('{"remoteHost":"git.example.com"}'))).toEqual({ remoteHost: 'git.example.com' })
    expect(await loadSettings(homeWith())).toEqual({})
    expect(await loadSettings(homeWith('not json'))).toEqual({})
    expect(await loadSettings(homeWith('{"remoteHost":""}'))).toEqual({})
  })

  test('warns about a settings file it cannot use', async () => {
    const broken = await capture(async () => loadSettings(homeWith('not json')))
    const wrongType = await capture(async () => loadSettings(homeWith('{"remoteHost":3}')))

    expect(broken.err).toContain('is not valid JSON')
    expect(wrongType.err).toContain('remoteHost')
    expect(wrongType.result).toEqual({})
  })

  test('left unset, ft remote checks nothing and says where to set it', async () => {
    const home = homeWith()
    const { result, out } = await capture(async () => remote([], home))

    expect(result).toBe(0)
    expect(out).toBe(`note: no Forgejo host to check origin against: pass --host, or set "remoteHost" in ${settingsPath(home)}\n`)
  })
})

describe('proveOrigin', () => {
  test('gives up on an origin that never answers', async () => {
    const root = temp('ft-remote-')
    const home = process.cwd()
    const before = limits.lsRemoteMs
    const env = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 }

    try {
      await $`git init -q ${root} && git remote add origin ${'ext::sleep 30'}`.cwd(root).quiet()
      process.chdir(root)
      limits.lsRemoteMs = 300
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'protocol.ext.allow'
      process.env.GIT_CONFIG_VALUE_0 = 'always'

      // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
      await expect(proveOrigin()).rejects.toThrow('no answer')
    }
    finally {
      limits.lsRemoteMs = before
      process.chdir(home)

      for (const [key, value] of Object.entries(env)) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  })
})
