import { describe, expect, test } from 'bun:test'
import { capped, limitOf, limitOptions } from '../src'

describe('limitOf', () => {
  test('reads --limit, falls back, and shows every row with --full', () => {
    expect(limitOf({}, 30)).toBe(30)
    expect(limitOf({ limit: '5' }, 30)).toBe(5)
    expect(limitOf({ full: true }, 30)).toBe(Number.POSITIVE_INFINITY)
  })

  test('leaves JSON uncut unless --limit is given', () => {
    expect(limitOf({ json: true }, 30)).toBe(Number.POSITIVE_INFINITY)
    expect(limitOf({ json: true, limit: '5' }, 30)).toBe(5)
  })

  test('refuses --limit with --full, and a limit that is no whole number', () => {
    expect(() => limitOf({ full: true, limit: '5' }, 30)).toThrow('exclude each other')
    expect(() => limitOf({ limit: 'x' }, 30)).toThrow('whole number')
  })
})

describe('capped', () => {
  test('keeps the first rows and counts the rest', () => {
    expect(capped([1, 2, 3, 4, 5], 2)).toEqual({ shown: [1, 2], footer: '3 more, rerun with --full' })
    expect(capped([1, 2], 2)).toEqual({ shown: [1, 2], footer: undefined })
    expect(capped([1, 2], Number.POSITIVE_INFINITY).footer).toBeUndefined()
  })
})

describe('limitOptions', () => {
  test('words the flags with the default', () => {
    expect(limitOptions(30).limit.description).toBe('show at most this many rows, the rest counted (30)')
  })

  test('takes -n as a short for --limit', () => {
    expect(limitOptions(30).limit.short).toBe('n')
  })
})
