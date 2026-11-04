import { describe, expect, test } from 'bun:test'
import { tidy } from '../src/tidy'

describe('tidy', () => {
  test('strips colour codes', () => {
    expect(tidy('\u001B[31mfail\u001B[0m ok', '/w/app')).toBe('fail ok')
  })

  test('makes paths under the working directory relative, and only those', () => {
    expect(tidy('/w/app/src/a.ts:1:2 and /w/app2/b.ts and x/w/app/c.ts', '/w/app')).toBe('./src/a.ts:1:2 and /w/app2/b.ts and x/w/app/c.ts')
    expect(tidy('(/w/app/src/a.ts)', '/w/app/')).toBe('(./src/a.ts)')
    expect(tidy('/a/b', '/')).toBe('/a/b')
  })
})
