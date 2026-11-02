import { describe, expect, test } from 'bun:test'
import { findSecrets, hint, isSecretKey, knownSecrets, maskLine, maskValue } from '../src/mask'

describe('maskValue', () => {
  test('masks by key name, keeping a few leading characters and the length', () => {
    for (const key of ['API_TOKEN', 'client_secret', 'DB_PASSWORD', 'STRIPE_KEY', 'PRIVATE_PEM', 'SENTRY_DSN'])
      expect(isSecretKey(key)).toBe(true)

    expect(maskValue('API_TOKEN', 'abcdefghijkl')).toBe('abc***(12)')
    expect(maskValue('API_TOKEN', 'abcd')).toBe('a***(4)')
    expect(maskValue('API_TOKEN', 'ab')).toBe('***(2)')
  })

  test('shows a plain value as is', () => {
    expect(isSecretKey('PORT')).toBe(false)
    expect(maskValue('PORT', '3000')).toBe('3000')
    expect(maskValue('EMPTY_TOKEN', '')).toBe('')
  })

  test('masks the password of a URL under any key', () => {
    expect(maskValue('DATABASE_URL', 'postgres://user:hunter22@host:5432/db')).toBe('postgres://user:***@host:5432/db')
    expect(maskValue('REDIS_URL', 'redis://:secretpass@cache:6379')).toBe('redis://:***@cache:6379')
  })

  test('leaves a URL without a password alone', () => {
    expect(maskValue('DATABASE_URL', 'postgres://user@host/db')).toBe('postgres://user@host/db')
    expect(maskValue('SITE_URL', 'https://example.com/path?a=1')).toBe('https://example.com/path?a=1')
  })

  test('masks a known token format under a plain key', () => {
    expect(maskValue('NOTE', `ghp_${'a'.repeat(36)}`)).toBe(hint(`ghp_${'a'.repeat(36)}`))
  })
})

describe('findSecrets', () => {
  test('finds each token format', () => {
    const formats = [
      `ghp_${'A1'.repeat(18)}`,
      `github_pat_${'a'.repeat(30)}`,
      `glpat-${'x'.repeat(20)}`,
      `sk-${'k'.repeat(32)}`,
      'xoxb-1234567890-abcdefghij',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
    ]

    for (const token of formats) {
      const line = `value: ${token} end`

      expect(findSecrets(line).map(match => line.slice(match.start, match.end))).toEqual([token])
      expect(maskLine(line)).not.toContain(token)
    }
  })

  test('does not take an ordinary word or a short sk- prefix for a token', () => {
    expect(maskLine('sk-short and task-force-one-two-three')).toBe('sk-short and task-force-one-two-three')
  })

  test('masks a value found in .env files, only as a whole word and from 6 characters', () => {
    const known = knownSecrets([['DB_PASSWORD', 'hunter22'], ['SHORT_TOKEN', 'abc12']])

    expect(maskLine('login with hunter22 now', known)).toBe('login with hu***(8) now')
    expect(maskLine('xhunter22x and hunter222', known)).toBe('xhunter22x and hunter222')
    expect(maskLine('abc12', known)).toBe('abc12')
    expect(findSecrets('hunter22', known)[0]?.kind).toBe('value of DB_PASSWORD')
  })

  test('escapes regex characters in known values and prefers the longest', () => {
    const known = knownSecrets([['A', 'p@ss.word+1'], ['B', 'p@ss.word+1-and-more']])

    expect(maskLine('p@ss.word+1-and-more', known)).toBe('p@s***(20)')
    expect(maskLine('pXssXword+1', known)).toBe('pXssXword+1')
  })
})

describe('URL tokens', () => {
  const opaque = 'Ab3dEf6hIj9kLm2NoPq5RsT8uVw1'
  const discord = `https://discord.com/api/webhooks/123456789012345678/${opaque}${opaque}`
  const kuma = 'http://127.0.0.1:55601/api/push/Zx9Cv8Bn7Mq6We5Rt4Yu3Io2Pa1S'

  test('masks the opaque last segment of a webhook or push URL, keeping the host and path', () => {
    expect(maskValue('DISCORD_WEBHOOK_URL', discord)).toBe('https://discord.com/api/webhooks/123456789012345678/Ab3***(56)')
    expect(maskValue('HEALTHCHECK_URL_BACKUP', kuma)).toBe('http://127.0.0.1:55601/api/push/Zx9***(28)')
  })

  test('masks a known webhook format whatever the token looks like', () => {
    expect(maskLine('https://discord.com/api/webhooks/1234567890/abcdefghijklmnop')).toBe('https://discord.com/api/webhooks/1234567890/abc***(16)')
    expect(maskLine('https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx')).toBe('https://hooks.slack.com/services/T0000000/B0000000/abc***(24)')
    expect(maskLine('http://kuma:3001/api/push/abcdefghijkl?status=up&msg=OK')).toBe('http://kuma:3001/api/push/abc***(12)?status=up&msg=OK')
    expect(maskLine('https://hc-ping.com/abcdefgh-1234-5678-abcd-0123456789ab')).toBe('https://hc-ping.com/abc***(36)')
  })

  test('masks a token-like query parameter and keeps the others', () => {
    for (const name of ['token', 'key', 'apikey', 'api_key', 'sig', 'access_token', 'secret'])
      expect(maskLine(`https://api.example.com/v1/items?page=2&${name}=abcdefghij&sort=asc`)).toBe(`https://api.example.com/v1/items?page=2&${name}=ab***(10)&sort=asc`)

    expect(maskLine('https://example.com/x?token=&key')).toBe('https://example.com/x?token=&key')
  })

  test('masks the URL after an export prefix and inside quotes', () => {
    expect(maskLine(`export WEBHOOK="${kuma}"`)).toBe('export WEBHOOK="http://127.0.0.1:55601/api/push/Zx9***(28)"')
  })

  test('leaves readable URLs alone', () => {
    for (const url of ['https://example.com/health', 'https://example.com/api/v1/users', 'https://example.com/blog/2024-11-02-release-notes-for-the-team', 'https://example.com/docs/getting-started-with-the-cli-tools', 'https://example.com/a?page=2&sort=name&keyword=abc', 'postgres://user@host/db'])
      expect(maskLine(url)).toBe(url)
  })

  test('masks a 32-character letters-and-digits segment of any case, not a 31-character or all-letters one', () => {
    const base = 'https://example.com/hook/'
    const hex = 'a1b2c3d4e5f60718'.repeat(2)

    expect(maskLine(`${base}${hex}`)).toBe(`${base}a1b***(32)`)
    expect(maskLine(`${base}${hex.repeat(2).slice(0, 40)}`)).toBe(`${base}a1b***(40)`)
    expect(maskLine(`${base}${hex.slice(0, 31)}`)).toBe(`${base}${hex.slice(0, 31)}`)
    expect(maskLine(`${base}${'abcdefgh'.repeat(5)}`)).toBe(`${base}${'abcdefgh'.repeat(5)}`)
  })

  test('opaque segment boundary: 20 characters mixing lowercase, uppercase and digits', () => {
    const base = 'https://example.com/'
    const mixed = 'aB3'.repeat(7)

    expect(maskLine(`${base}${mixed.slice(0, 20)}`)).toBe(`${base}aB3***(20)`)
    expect(maskLine(`${base}${mixed.slice(0, 19)}`)).toBe(`${base}${mixed.slice(0, 19)}`)
    expect(maskLine(`${base}${mixed.slice(0, 20).toLowerCase()}`)).toBe(`${base}${mixed.slice(0, 20).toLowerCase()}`)
    expect(maskLine(`${base}${'aBc'.repeat(7).slice(0, 20)}`)).toBe(`${base}${'aBc'.repeat(7).slice(0, 20)}`)
  })
})
