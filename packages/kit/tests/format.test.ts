import { describe, expect, test } from 'bun:test'
import { formatAge, formatSeconds, table } from '../src/format'

describe('format', () => {
  test('gives the largest unit and the next one when not zero', () => {
    expect(formatSeconds(0)).toBe('0s')
    expect(formatSeconds(57)).toBe('57s')
    expect(formatSeconds(808)).toBe('13m 28s')
    expect(formatSeconds(3605)).toBe('1h')
    expect(formatSeconds(90_000)).toBe('1d 1h')
    expect(formatAge(Date.now() - 3 * 3600_000 - 60_000)).toBe('3h ago')
    expect(formatAge('not a date')).toBe('-')
  })

  test('pads every column but the last', () => {
    expect(table([['a', 'long', 'x'], ['bb', 'c', 'y']])).toBe('a   long  x\nbb  c     y')
  })
})
