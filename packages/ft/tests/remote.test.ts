import { describe, expect, test } from 'bun:test'
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
