import { describe, expect, test } from 'bun:test'
import { formatZoned, humanDuration, parseDate, parseDuration, relative } from '../src/time'
import { convert } from '../src/ts'

const PARIS = 'Europe/Paris'
const NOW = Date.UTC(2024, 4, 6, 12, 0, 0)

describe('formatZoned', () => {
  test('writes the offset of the zone at that instant, UTC as UTC', () => {
    expect(formatZoned(1_700_000_000_000, PARIS)).toBe('2023-11-14 23:13:20 +01:00')
    expect(formatZoned(1_715_000_000_000, PARIS)).toBe('2024-05-06 14:53:20 +02:00')
    expect(formatZoned(1_700_000_000_000, 'America/New_York')).toBe('2023-11-14 17:13:20 -05:00')
    expect(formatZoned(1_700_000_000_000, 'Asia/Kolkata')).toBe('2023-11-15 03:43:20 +05:30')
    expect(formatZoned(1_700_000_000_000, 'UTC')).toBe('2023-11-14 22:13:20 UTC')
    expect(formatZoned(1_700_000_000_000, 'Etc/GMT')).toBe('2023-11-14 22:13:20 +00:00')
  })

  test('midnight is 00 not 24', () => {
    expect(formatZoned(Date.UTC(2024, 0, 1), 'UTC')).toBe('2024-01-01 00:00:00 UTC')
  })
})

describe('durations', () => {
  test('parseDuration reads units alone or chained', () => {
    expect(parseDuration('90m')).toBe(5_400_000)
    expect(parseDuration('2h30m')).toBe(9_000_000)
    expect(parseDuration('1d12h')).toBe(129_600_000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('1.5h')).toBe(5_400_000)
    expect(parseDuration('45s')).toBe(45_000)
  })

  test('parseDuration refuses anything else', () => {
    for (const text of ['', '90', 'h', '2x', '2h 30m', '30m2h5', '2024-01-01'])
      expect(parseDuration(text)).toBeUndefined()
  })

  test('humanDuration keeps the two largest units', () => {
    expect(humanDuration(9_000_000)).toBe('2h 30m')
    expect(humanDuration(90_061_000)).toBe('1d 1h')
    expect(humanDuration(45_000)).toBe('45s')
    expect(humanDuration(400)).toBe('0s')
  })

  test('relative says in, ago and now', () => {
    expect(relative(NOW + 9_000_000, NOW)).toBe('in 2h 30m')
    expect(relative(NOW - 300_000, NOW)).toBe('5m ago')
    expect(relative(NOW + 200, NOW)).toBe('now')
  })
})

describe('parseDate', () => {
  test('a date-time with Z or an offset carries its own zone', () => {
    expect(parseDate('2024-05-06T08:09:10Z', PARIS)).toBe(Date.UTC(2024, 4, 6, 8, 9, 10))
    expect(parseDate('2024-05-06T08:09:10+02:00', 'UTC')).toBe(Date.UTC(2024, 4, 6, 6, 9, 10))
    expect(parseDate('2024-05-06 08:09:10 +0200', 'UTC')).toBe(Date.UTC(2024, 4, 6, 6, 9, 10))
    expect(parseDate('2024-05-06T08:09:10.250Z')).toBe(Date.UTC(2024, 4, 6, 8, 9, 10, 250))
  })

  test('a date-time without a zone, or a bare date, is read in the given zone', () => {
    expect(parseDate('2024-05-06T08:09:10', PARIS)).toBe(Date.UTC(2024, 4, 6, 6, 9, 10))
    expect(parseDate('2024-01-06 08:09', PARIS)).toBe(Date.UTC(2024, 0, 6, 7, 9))
    expect(parseDate('2024-05-06', 'America/New_York')).toBe(Date.UTC(2024, 4, 6, 4))
    expect(parseDate('2024-05-06T08:09:10', 'UTC')).toBe(Date.UTC(2024, 4, 6, 8, 9, 10))
  })

  test('a wall time inside the spring gap lands an hour later', () => {
    expect(parseDate('2024-03-31T02:30', PARIS)).toBe(Date.UTC(2024, 2, 31, 1, 30))
  })

  test('anything else is not a date', () => {
    for (const text of ['yesterday', '2024-13-45', '06/05/2024', '2024-05-06T25:00Z'])
      expect(parseDate(text, 'UTC')).toBeUndefined()
  })
})

describe('convert', () => {
  test('no value is now', () => {
    expect(convert(undefined, { now: NOW, timeZone: PARIS })).toMatchObject({ kind: 'now', ms: NOW, local: '2024-05-06 14:00:00 +02:00', utc: '2024-05-06 12:00:00 UTC', relative: 'now' })
    expect(convert('  ', { now: NOW }).kind).toBe('now')
  })

  test('epoch seconds and milliseconds are told apart by size', () => {
    expect(convert('1700000000', { now: NOW, timeZone: PARIS })).toMatchObject({ kind: 'epoch-seconds', ms: 1_700_000_000_000, seconds: 1_700_000_000, local: '2023-11-14 23:13:20 +01:00', utc: '2023-11-14 22:13:20 UTC' })
    expect(convert('1700000000123', { now: NOW, timeZone: PARIS })).toMatchObject({ kind: 'epoch-milliseconds', ms: 1_700_000_000_123, seconds: 1_700_000_000 })
    expect(convert('0', { now: NOW })).toMatchObject({ kind: 'epoch-seconds', ms: 0, utc: '1970-01-01 00:00:00 UTC' })
    expect(convert('99999999999', { now: NOW }).kind).toBe('epoch-seconds')
    expect(convert('100000000000', { now: NOW }).kind).toBe('epoch-milliseconds')
  })

  test('an epoch with decimals keeps its milliseconds', () => {
    expect(convert('1700000000.5', { now: NOW })).toMatchObject({ kind: 'epoch-seconds', ms: 1_700_000_000_500 })
  })

  test('an ISO date is read in the zone, an offset one as written', () => {
    expect(convert('2024-05-06T08:09:10', { now: NOW, timeZone: PARIS })).toMatchObject({ kind: 'date', ms: Date.UTC(2024, 4, 6, 6, 9, 10), local: '2024-05-06 08:09:10 +02:00', utc: '2024-05-06 06:09:10 UTC', relative: '5h 50m ago' })
    expect(convert('2024-05-06T08:09:10Z', { now: NOW, timeZone: PARIS })).toMatchObject({ local: '2024-05-06 10:09:10 +02:00' })
  })

  test('a duration gives its length and the date that far from now', () => {
    expect(convert('2h30m', { now: NOW, timeZone: PARIS })).toEqual({ kind: 'duration', ms: 9_000_000, seconds: 9000, human: '2h 30m', fromNow: { local: '2024-05-06 16:30:00 +02:00', utc: '2024-05-06 14:30:00 UTC' } })
    expect(convert('90m', { now: NOW })).toMatchObject({ seconds: 5400, human: '1h 30m' })
  })

  test('an unreadable value throws naming it', () => {
    expect(() => convert('soon')).toThrow('soon is not an epoch')
    expect(() => convert('99999999999999999999')).toThrow('out of range')
  })
})
