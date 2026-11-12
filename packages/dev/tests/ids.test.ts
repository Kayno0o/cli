import { describe, expect, test } from 'bun:test'
import { monotonic, nextUlid, nextUuidV7, ulid, uuidV4, uuidV7 } from '../src/ids'

describe('uuidV7', () => {
  test('matches the RFC 9562 example', () => {
    const random = Uint8Array.from([0x0C, 0xC3, 0x98, 0xC4, 0xDC, 0x0C, 0x0C, 0x07, 0x39, 0x8F])

    expect(uuidV7(0x017F22E279B0, random)).toBe('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')
  })

  test('sets the version and variant whatever the random bytes are', () => {
    expect(uuidV7(0, new Uint8Array(10).fill(0xFF))).toBe('00000000-0000-7fff-bfff-ffffffffffff')
    expect(uuidV7(0, new Uint8Array(10))).toBe('00000000-0000-7000-8000-000000000000')
  })

  test('a random one is well formed and sorts by time', () => {
    const first = uuidV7(1_700_000_000_000)
    const second = uuidV7(1_700_000_000_001)

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first < second).toBe(true)
  })
})

describe('uuidV4', () => {
  test('is a version 4 UUID', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('ulid', () => {
  test('encodes the time as the ULID spec does', () => {
    expect(ulid(1_469_918_176_385, new Uint8Array(16))).toBe('01ARYZ6S410000000000000000')
    expect(ulid(0, new Uint8Array(16))).toBe('00000000000000000000000000')
  })

  test('maps random bytes onto the Crockford alphabet', () => {
    expect(ulid(0, new Uint8Array(16).fill(31))).toBe('0000000000ZZZZZZZZZZZZZZZZ')
    expect(ulid(0, new Uint8Array(16).fill(0xFF))).toBe('0000000000ZZZZZZZZZZZZZZZZ')
  })

  test('a random one has 26 characters and sorts by time', () => {
    const first = ulid(1_700_000_000_000)

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(first < ulid(1_700_000_000_001)).toBe(true)
  })
})

describe('monotonic', () => {
  test('a batch drawn in one millisecond sorts in the order it was made', () => {
    const clock = () => 1_700_000_000_000

    for (const [draw, next] of [[(now: number) => ulid(now), nextUlid], [(now: number) => uuidV7(now), nextUuidV7]] as const) {
      const ids = monotonic(50, draw, next, clock)

      expect(ids).toEqual(ids.toSorted())
      expect(new Set(ids).size).toBe(50)
    }
  })

  test('the successor carries out of the random part into the time', () => {
    expect(nextUlid('0000000000ZZZZZZZZZZZZZZZZ')).toBe('00000000010000000000000000')
    expect(nextUuidV7('00000000-0000-7fff-bfff-ffffffffffff')).toBe('00000000-0001-7000-8000-000000000000')
    expect(nextUuidV7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')).toBe('017f22e2-79b0-7cc3-98c4-dc0c0c073990')
  })
})
