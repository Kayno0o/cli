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
