import { describe, expect, test } from 'bun:test'
import { installRequests } from '../src/pin'

describe('installRequests', () => {
  test('keeps an = inside a --cwd value', () => {
    expect(installRequests('bun --cwd=/w/a=b add zod', '/w', '/home')[0]?.dir).toBe('/w/a=b')
  })
})
