import { describe, expect, test } from 'bun:test'
import { EXACT_VERSION, inRange, isRange } from '../src/semver'

describe('isRange', () => {
  test('accepts ranges and refuses words', () => {
    for (const range of ['^1.2.3', '~1.2', '>=1 <2 || 3.x', '1.0.0 - 2.0.0', '*', ''])
      expect(isRange(range)).toBe(true)

    for (const range of ['banana', 'latest', '1.2.3 banana'])
      expect(isRange(range)).toBe(false)
  })
})

describe('inRange', () => {
  test('counts a prerelease below an upper bound as inside it', () => {
    expect(inRange('1.0.0-beta.1', '<1.2.0')).toBe(true)
    expect(inRange('1.0.0-beta.1', '>=1.0.0 <1.2.0')).toBe(false)
    expect(inRange('1.3.0-beta.1', '<1.2.0')).toBe(false)
    expect(inRange('1.1.0', '>=1.0.0 <1.2.0')).toBe(true)
  })
})

describe('EXACT_VERSION', () => {
  test('matches a version and not a range or tag', () => {
    expect(EXACT_VERSION.test('1.2.3')).toBe(true)
    expect(EXACT_VERSION.test('1.2.3-beta.1')).toBe(true)
    expect(EXACT_VERSION.test('^1.2.3')).toBe(false)
    expect(EXACT_VERSION.test('latest')).toBe(false)
  })
})
