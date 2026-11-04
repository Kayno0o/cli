import { expect, test } from 'bun:test'
import { parseSize } from '../src/size'

test('parseSize reads units, decimals, MiB spellings and a bare number in the unit asked', () => {
  expect(parseSize('500M')).toBe(500 * 1024 ** 2)
  expect(parseSize('1.5g')).toBe(1.5 * 1024 ** 3)
  expect(parseSize('800kb')).toBe(800 * 1024)
  expect(parseSize('2MiB')).toBe(2 * 1024 ** 2)
  expect(parseSize('100')).toBe(100)
  expect(parseSize('2', 1024 ** 2)).toBe(2 * 1024 ** 2)
  expect(parseSize('lots')).toBeUndefined()
  expect(parseSize('-1M')).toBeUndefined()
})
