import { describe, expect, test } from 'bun:test'
import { claimTimes, decodeJwt } from '../src/jwt'

// The jwt.io sample: HS256, iat 1516239022 (2018-01-18T01:30:22Z).
const SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

function token(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'none' })}.${part(payload)}.`
}

describe('decodeJwt', () => {
  test('reads the header, the payload and the signature size', () => {
    expect(decodeJwt(SAMPLE)).toEqual({ header: { alg: 'HS256', typ: 'JWT' }, payload: { sub: '1234567890', name: 'John Doe', iat: 1_516_239_022 }, signatureBytes: 32 })
  })

  test('ignores a Bearer prefix and surrounding whitespace', () => {
    expect(decodeJwt(`  Bearer ${SAMPLE}\n`).header).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  test('takes an unsigned token', () => {
    expect(decodeJwt(token({ a: 1 }))).toMatchObject({ payload: { a: 1 }, signatureBytes: 0 })
  })

  test('refuses what is not a JWT', () => {
    expect(() => decodeJwt('abc')).toThrow('3 dot-separated parts, this has 1')
    expect(() => decodeJwt('a.b.c.d')).toThrow('this has 4')
    expect(() => decodeJwt('!!!.e30.x')).toThrow('the header is not base64url JSON')
    expect(() => decodeJwt(`e30.${Buffer.from('[1]').toString('base64url')}.x`)).toThrow('the payload is not a JSON object')
  })
})

describe('claimTimes', () => {
  const now = Date.UTC(2024, 4, 6, 12, 0, 0)

  test('lists iat, nbf and exp in that order as dates against now', () => {
    const { payload } = decodeJwt(token({ exp: now / 1000 + 3600, nbf: now / 1000 - 60, iat: now / 1000 - 120, sub: 'x' }))

    expect(claimTimes(payload, now, 'Europe/Paris')).toEqual([
      { claim: 'iat', epoch: now / 1000 - 120, local: '2024-05-06 13:58:00 +02:00', utc: '2024-05-06 11:58:00 UTC', relative: '2m ago' },
      { claim: 'nbf', epoch: now / 1000 - 60, local: '2024-05-06 13:59:00 +02:00', utc: '2024-05-06 11:59:00 UTC', relative: '1m ago' },
      { claim: 'exp', epoch: now / 1000 + 3600, local: '2024-05-06 15:00:00 +02:00', utc: '2024-05-06 13:00:00 UTC', relative: 'in 1h' },
    ])
  })

  test('the sample token issued date', () => {
    expect(claimTimes(decodeJwt(SAMPLE).payload, now, 'UTC')).toMatchObject([{ claim: 'iat', utc: '2018-01-18 01:30:22 UTC' }])
  })

  test('skips claims that are not numbers', () => {
    expect(claimTimes({ exp: '1700000000', iat: null }, now)).toEqual([])
  })
})
