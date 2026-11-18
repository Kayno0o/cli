import type { Finding } from '../src/report'
import { describe, expect, test } from 'bun:test'
import { findingLines } from '../src/report'

const PLAIN = { isTTY: false }

function found(width: number, kind: string, selector: string | undefined, message: string): Finding {
  return { target: 'http://localhost:3001/apps', width, kind, ...selector === undefined ? {} : { selector }, message }
}

describe('findingLines', () => {
  test('one heading per target, width and kind, its findings under it, a repeated one counted once', () => {
    const findings = [
      found(1440, 'request', undefined, 'GET /env.js answered 404'),
      found(1440, 'tap-target', 'button.sort', '69×16px, under 24px'),
      found(1440, 'padding', 'span.badge', 'text touches its top edge, no padding'),
      found(1440, 'tap-target', 'a.icon', '20×20px, under 24px'),
      found(1440, 'padding', 'span.badge', 'text touches its top edge, no padding'),
      found(1440, 'padding', 'span.badge', 'text touches its top edge, no padding'),
      found(400, 'tap-target', 'button.sort', '69×16px, under 44px'),
    ]

    expect(findingLines(findings, PLAIN)).toEqual([
      'http://localhost:3001/apps 1440px request',
      '  GET /env.js answered 404',
      'http://localhost:3001/apps 1440px tap-target',
      '  button.sort: 69×16px, under 24px',
      '  a.icon: 20×20px, under 24px',
      'http://localhost:3001/apps 1440px padding',
      '  span.badge: text touches its top edge, no padding ×3',
      'http://localhost:3001/apps 400px tap-target',
      '  button.sort: 69×16px, under 44px',
    ])
  })

  test('past ten different findings a heading says how many more there are', () => {
    const findings = Array.from({ length: 13 }, (_, n) => found(400, 'tap-target', `button.b${n}`, '20×20px, under 44px'))

    expect(findingLines(findings, PLAIN).slice(-2)).toEqual(['  button.b9: 20×20px, under 44px', '  3 more'])
  })
})
