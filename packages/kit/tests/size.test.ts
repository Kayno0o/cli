import { expect, test } from 'bun:test'
import { formatSize, parseSize } from '../src/size'

test('parseSize reads units, decimals, MiB spellings and a bare number in the unit asked', () => {
  expect(parseSize('500M')).toBe(500 * 1024 ** 2)
  expect(parseSize('1.5g')).toBe(1.5 * 1024 ** 3)
  expect(parseSize('800kb')).toBe(800 * 1024)
  expect(parseSize('2MiB')).toBe(2 * 1024 ** 2)
  expect(parseSize('100')).toBe(100)
  expect(parseSize('2', 1024 ** 2)).toBe(2 * 1024 ** 2)
  expect(parseSize('500b', 1024 ** 2)).toBe(500)
  expect(parseSize('500 B')).toBe(500)
  expect(parseSize('5ib')).toBeUndefined()
  expect(parseSize('lots')).toBeUndefined()
  expect(parseSize('-1M')).toBeUndefined()
})

test('formatSize keeps bytes whole, one decimal under 10 of a unit and none above', () => {
  expect(formatSize(512)).toBe('512B')
  expect(formatSize(1536)).toBe('1.5K')
  expect(formatSize(38 * 1024 ** 2)).toBe('38M')
  expect(formatSize(3 * 1024 ** 5)).toBe('3072T')
  expect(formatSize(1048575)).toBe('1.0M')
  expect(formatSize(1023 * 1024)).toBe('1023K')
})
