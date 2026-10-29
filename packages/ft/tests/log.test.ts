import { describe, expect, test } from 'bun:test'
import { excerpt, failedTests, logLines } from '../src/log'

const log = await Bun.file(new URL('fixtures/failed-job.log', import.meta.url)).text()

describe('failedTests', () => {
  test('gives each failed test its own output, once, though bun lists it again at the end', () => {
    const blocks = failedTests(logLines(log))
    const lifecycle = blocks.filter(block => block.includes('lifecycle > on SIGTERM'))

    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]).toStartWith('killed 1 dangling process')
    expect(blocks.join('\n')).not.toContain('(pass) ')
    expect(blocks.join('\n')).not.toContain('::group::')
  })

  test('caps the blocks at ten and counts the rest', () => {
    const lines = Array.from({ length: 13 }, (_, index) => `(fail) case ${index} [1.00ms]`)
    const blocks = failedTests(lines)

    expect(blocks).toHaveLength(11)
    expect(blocks.at(-1)).toBe('and 3 more failed tests')
  })
})

describe('excerpt', () => {
  test('strips the timestamps and ends on the failed step, passing tests left out', () => {
    const text = excerpt(log)

    expect(text).not.toMatch(/^\d{4}-\d\d-\d\dT/m)
    expect(text).toContain('❌  Failure - Main Tests')
    expect(text).toContain('9 tests failed:')
    expect(text).not.toContain('(pass) kay check --fix')
  })

  test('falls back to the last lines when nothing marks a failure', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `2026-10-22T19:58:27.2681088Z line ${index}`)
    const text = excerpt(lines.join('\n'))

    expect(text).toStartWith('line 20')
    expect(text).toEndWith('line 59')
  })
})
