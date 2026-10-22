import { describe, expect, test } from 'bun:test'
import { canonicalRemote, parseSshRemote } from '../src/remote'

const HOST = 'git.kaynooo.fr'
const resolve = (alias: string) => (alias === 'forgejo' || alias === 'gitea' || alias === HOST ? HOST : alias)

describe('canonicalRemote', () => {
  test('switches an alias remote, in every spelling, to git@<host>:<owner>/<repo>.git', () => {
    for (const url of ['forgejo:kaynooo/kayjs.git', 'git@forgejo:kaynooo/kayjs.git', 'gitea:kaynooo/kayjs', 'ssh://git@forgejo/kaynooo/kayjs.git', 'ssh://git@forgejo:22022/kaynooo/kayjs/'])
      expect(canonicalRemote(url, HOST, resolve)).toBe('git@git.kaynooo.fr:kaynooo/kayjs.git')
  })

  test('leaves the host itself, another host and an https remote alone', () => {
    for (const url of ['git@git.kaynooo.fr:kaynooo/kayjs.git', 'ssh://git@git.kaynooo.fr/kaynooo/kayjs.git', 'git@github.com:Kayno0o/kayjs.git', 'https://git.kaynooo.fr/kaynooo/kayjs.git'])
      expect(canonicalRemote(url, HOST, resolve)).toBeUndefined()
  })
})

describe('parseSshRemote', () => {
  test('reads user, host and path, and no https URL', () => {
    expect(parseSshRemote('deploy@forgejo:a/b.git')).toEqual({ user: 'deploy', host: 'forgejo', path: 'a/b' })
    expect(parseSshRemote('https://git.kaynooo.fr/a/b.git')).toBeUndefined()
  })
})
