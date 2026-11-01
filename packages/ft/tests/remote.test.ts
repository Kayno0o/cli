import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { remote } from '../src/commands/remote'
import { loadSettings, settingsPath } from '../src/config'
import { canonicalRemote, parseSshRemote, reachesHost } from '../src/remote'

const HOST = 'git.kaynooo.fr'
const reaches = (alias: string) => alias === 'forgejo' || alias === 'gitea'

describe('canonicalRemote', () => {
  test('switches an alias remote, in every spelling, to git@<host>:<owner>/<repo>.git', () => {
    for (const url of ['forgejo:kaynooo/kayjs.git', 'git@forgejo:kaynooo/kayjs.git', 'gitea:kaynooo/kayjs', 'ssh://git@forgejo/kaynooo/kayjs.git', 'ssh://git@forgejo:22022/kaynooo/kayjs/'])
      expect(canonicalRemote(url, HOST, reaches)).toBe('git@git.kaynooo.fr:kaynooo/kayjs.git')
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
    const home = mkdtempSync(join(tmpdir(), 'ft-home-'))

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

  test('left unset, ft remote checks nothing and says where to set it', async () => {
    const home = homeWith()
    const { result, out } = await capture(async () => remote([], home))

    expect(result).toBe(0)
    expect(out).toBe(`note: no Forgejo host to check origin against: pass --host, or set "remoteHost" in ${settingsPath(home)}\n`)
  })
})
