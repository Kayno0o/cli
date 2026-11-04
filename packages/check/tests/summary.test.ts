import { describe, expect, test } from 'bun:test'
import { summaryLine } from '../src/check'

const outcome = (ok: boolean, ms: number) => ({ name: 'lint', command: 'lint', ok, ms, log: '/log' })

describe('summaryLine', () => {
  test('counts what passed and the time the steps took together', () => {
    expect(summaryLine([outcome(true, 400), outcome(true, 1100)])).toBe('2 passed · 1.5s')
  })

  test('adds what failed only when something did', () => {
    expect(summaryLine([outcome(true, 400), outcome(false, 600)])).toBe('1 passed · 1 failed · 1.0s')
  })
})
