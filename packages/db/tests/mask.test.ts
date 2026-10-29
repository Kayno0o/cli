import { describe, expect, test } from 'bun:test'
import { maskRows, scrub, sensitiveKind } from '../src/mask'
import { cell, render, shape } from '../src/output'

const URL = 'postgres://app:s3cr%40t-pw@db.example.com:5432/shop'

describe('masking', () => {
  test('recognizes sensitive column names only', () => {
    for (const name of ['email', 'user_email', 'mobile_phone', 'api_token', 'password_hash', 'secret', 'passwd'])
      expect(sensitiveKind(name)).toBeDefined()

    for (const name of ['id', 'name', 'status', 'compass', 'created_at'])
      expect(sensitiveKind(name)).toBeUndefined()
  })

  test('masks values but keeps nulls, unless raw', () => {
    const rows = [{ id: 1, email: 'a@b.c' }, { id: 2, email: null }]

    expect(maskRows(rows, false)).toEqual({ rows: [{ id: 1, email: '***' }, { id: 2, email: null }], masked: ['email'] })
    expect(maskRows(rows, true).rows).toBe(rows)
  })
})

describe('scrub', () => {
  test('removes the url, the password in both forms and credentials in other urls', () => {
    const text = `could not connect to ${URL}: password s3cr%40t-pw / s3cr@t-pw rejected, also mysql://root:hunter2@host/x`
    const clean = scrub(text, URL)

    expect(clean).not.toContain('s3cr')
    expect(clean).not.toContain('hunter2')
    expect(clean).not.toContain('app:')
  })

  test('still strips credentials with no url known', () => {
    expect(scrub('postgres://u:p@h/db', undefined)).toBe('postgres://<credentials>@h/db')
  })
})

describe('output', () => {
  const rows = Array.from({ length: 5 }, (_, id) => ({ id, email: `u${id}@x.io` }))

  test('caps rows and says how many were left out', () => {
    const shown = shape(rows, 2, false)

    expect(shown.rows).toHaveLength(2)
    expect(shown.omitted).toBe(3)
    expect(render(shown, false)).toContain('3 more rows not shown (5 in all')
    expect(render(shown, false)).toContain('masked: email')
    expect(render(shown, false)).not.toContain('u0@x.io')
  })

  test('prints JSON with bigint and bytes', () => {
    const json = JSON.parse(render(shape([{ n: 10n, b: new Uint8Array(3) }], 10, true), true)) as { rows: unknown, omitted: number }

    expect(json.rows).toEqual([{ n: '10', b: '<3 bytes>' }])
    expect(json.omitted).toBe(0)
  })

  test('formats cells and an empty result', () => {
    expect(cell(null)).toBe('NULL')
    expect(cell(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(cell({ a: 1 })).toBe('{"a":1}')
    expect(render(shape([], 10, false), false)).toBe('no rows')
  })
})
