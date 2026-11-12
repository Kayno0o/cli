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

  test('masks a value found in .env files, only as a whole word and from 4 characters', () => {
    const known = knownSecrets([['DB_PASSWORD', 'hunter22'], ['SHORT_TOKEN', 'abc'], ['PIN_KEY', 'abc12']])

    expect(maskLine('login with hunter22 now', known)).toBe('login with hu***(8) now')
    expect(maskLine('xhunter22x and hunter222', known)).toBe('xhunter22x and hunter222')
    expect(maskLine('abc12 abc', known)).toBe('a***(5) abc')
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

describe('maskLine keyword values', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

  test('masks the value after a secret keyword, keeping the key', () => {
    for (const [line, key] of [
      ['password: hunter22', 'password: '],
      ['password = hunter22', 'password = '],
      ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = '],
      ['export GITHUB_TOKEN=abcd1234efgh', 'export GITHUB_TOKEN='],
      ['AUTH_TOKEN=abcd1234efgh', 'AUTH_TOKEN='],
      ['{"access_token":"abcd1234efgh"}', '{"access_token":"'],
      ['X-Api-Key: abcd1234efgh', 'X-Api-Key: '],
      ['Server=x;AccountKey=abcd1234efgh==;EndpointSuffix=core', 'Server=x;AccountKey='],
      ['SharedAccessKey=abcd1234efgh', 'SharedAccessKey='],
      ['private_key: "abcd1234efgh"', 'private_key: "'],
    ] as const) {
      const masked = maskLine(line)

      expect(masked).toStartWith(key)
      expect(masked).not.toContain('abcd1234efgh')
      expect(masked).not.toContain('hunter22')
      expect(masked).not.toContain(secret)
    }
  })

  test('masks the value under any secret name, camelCase and run-together ones included', () => {
    for (const line of ['PGPASSWORD=hunter22', 'MYSQL_PWD=hunter22', 'DB_PASS=hunter22', 'DBPASS=hunter22', 'GPG_PASSPHRASE=hunter22', 'clientSecret=hunter22', '{"clientSecret": "hunter22"}', '{"refreshToken":"hunter22x1"}', 'spring.datasource.password=hunter22'])
      expect(maskLine(line)).not.toContain('hunter22')
  })

  test('masks a printed variable to the end of its line, and each of several on one line', () => {
    expect(maskLine('DB_PASSWORD=my secret value here')).toBe('DB_PASSWORD=my ***(20)')
    expect(maskLine('PGPASSWORD=hunter2hunter2 MYSQL_PWD=hunter2hunter2')).not.toContain('hunter2hunter2')
    expect(maskLine('log: password=hunter22 user=bob')).toBe('log: password=hu***(8) user=bob')
  })

  test('masks a number under a secret name, but leaves settings and counts alone', () => {
    for (const [name, value] of [['token', '48291037'], ['access_token', '4829103755'], ['auth', '123456789'], ['SESSIONID', '1234567890'], ['api_tokens', '12345678'], ['access_tokens', '4829103755']])
      expect(maskLine(`${name}=${value}`)).not.toContain(value!)

    for (const line of ['TOKEN_TTL=3600', 'AUTH_URL=https://auth.example.com/login', 'PASSWORD_FILE=/run/secrets/db', 'max_tokens=4096', 'MAX_TOKENS=4096', 'num_sessions=12', 'tokens: 1234', 'key=value', 'SESSION_DRIVER=redis'])
      expect(maskLine(line)).toBe(line)
  })

  test('masks a password given on a command line', () => {
    expect(maskLine('mysql -u root -phunter22 db')).toBe('mysql -u root -phu***(8) db')
    expect(maskLine('sshpass -p hunter22 ssh host')).toBe('sshpass -p hu***(8) ssh host')
  })

  test('masks prefixed tokens', () => {
    for (const token of [
      `hf_${'a'.repeat(34)}`,
      `whsec_${'a1'.repeat(15)}`,
      `dop_v1_${'a1'.repeat(30)}`,
      `shpat_${'a1'.repeat(16)}`,
      `glrt-${'a1'.repeat(12)}`,
      `gldt-${'a1'.repeat(12)}`,
      `glptt-${'a1'.repeat(12)}`,
    ])
      expect(maskLine(`value ${token} end`)).not.toContain(token)
  })

  test('leaves prose, short values and settings alone', () => {
    for (const line of ['token: 5', 'auth: true', 'token: expired', 'auth: failed for user', 'password: required', 'author: Bob', 'the password policy: strict', 'credential: invalid', 'mysql -u root db', 'hf_short whsec_x', 'tokens: 1234'])
      expect(maskLine(line)).toBe(line)
  })
})
