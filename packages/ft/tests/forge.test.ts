import { describe, expect, test } from 'bun:test'
import { ghLogins, glabLogins, originHost, parseRemote, parseRepoSpec, redactUrl, teaLogins } from '../src/provider'

describe('parseRemote and originHost', () => {
  test('reads host and repo from scp, ssh, https, and nested GitLab groups', () => {
    expect(originHost('git@git.kaynooo.fr:kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(originHost('ssh://git@git.kaynooo.fr:22022/kaynooo/cli.git')).toBe('git.kaynooo.fr')
    expect(originHost('https://GitLab.com/team/sub/app.git\n')).toBe('gitlab.com')
    expect(parseRemote('git@gitlab.com:team/sub/app.git')).toEqual({ host: 'gitlab.com', repo: 'team/sub/app' })
    expect(originHost('/srv/git/cli.git')).toBeUndefined()
  })

  test('redacts embedded URL credentials', () => {
    expect(redactUrl('https://me:secret@gitlab.com/x/y.git')).toBe('https://***@gitlab.com/x/y.git')
  })
})

describe('parseRepoSpec', () => {
  test('recognizes gh:, gl:, fj: prefixes and bare owner/repo', () => {
    expect(parseRepoSpec('gh:owner/repo')).toEqual({ provider: 'github', repo: 'owner/repo' })
    expect(parseRepoSpec('gl:group/sub/repo')).toEqual({ provider: 'gitlab', repo: 'group/sub/repo' })
    expect(parseRepoSpec('fj:kaynooo/cli')).toEqual({ provider: 'forgejo', repo: 'kaynooo/cli' })
    expect(parseRepoSpec('kaynooo/cli')).toEqual({ repo: 'kaynooo/cli' })
  })
})

describe('config token parsers', () => {
  test('parses tea, glab-cli, and gh config files without spawning subprocesses', () => {
    const tea = `logins:
  - name: main
    url: "https://git.kaynooo.fr"
    ssh_host: git.kaynooo.fr:22
    token: tok-tea
    default: true
`

    expect(teaLogins(tea)).toEqual([{ url: 'https://git.kaynooo.fr', sshHost: 'git.kaynooo.fr', token: 'tok-tea', isDefault: true }])

    const glab = `hosts:
  gitlab.example.com:
    token: tok-glab
    api_host: gitlab.example.com
    api_protocol: https
`

    expect(glabLogins(glab)).toEqual([{ host: 'gitlab.example.com', apiHost: 'gitlab.example.com', protocol: 'https', token: 'tok-glab' }])

    const tagged = `hosts:
  gitlab.com:
    token: !!null glpat-tok
`

    expect(glabLogins(tagged)).toEqual([{ host: 'gitlab.com', apiHost: 'gitlab.com', protocol: 'https', token: 'glpat-tok' }])

    const gh = `github.com:
  user: kaynooo
  oauth_token: gho_secret123
`

    expect(ghLogins(gh)).toEqual([{ host: 'github.com', token: 'gho_secret123' }])
  })
})
