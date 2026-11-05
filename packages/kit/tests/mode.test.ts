import { describe, expect, test } from 'bun:test'
import { jsonText } from '../src/format'
import { exampleRows, replacesRows } from '../src/help'
import { isInteractive, outputMode } from '../src/mode'

const TERMINAL = { isTTY: true }

describe('outputMode', () => {
  test('is a terminal on a tty, a pipe off it', () => {
    expect(outputMode(TERMINAL, {})).toBe('terminal')
    expect(outputMode({}, {})).toBe('pipe')
  })

  test('is ci off a terminal when CI is set, not when it is 0 or false', () => {
    expect(outputMode({}, { CI: 'true' })).toBe('ci')
    expect(outputMode({}, { CI: '0' })).toBe('pipe')
    expect(outputMode({}, { CI: 'false' })).toBe('pipe')
    expect(outputMode(TERMINAL, { CI: 'true' })).toBe('terminal')
  })

  test('is agent for Claude Code or AI_AGENT, on a pty too, and ahead of CI', () => {
    expect(outputMode({}, { CLAUDECODE: '1' })).toBe('agent')
    expect(outputMode(TERMINAL, { AI_AGENT: 'opencode' })).toBe('agent')
    expect(outputMode({}, { CLAUDECODE: '1', CI: 'true' })).toBe('agent')
  })

  test('takes KIT_MODE over everything, an unknown value being ignored', () => {
    expect(outputMode(TERMINAL, { CLAUDECODE: '1', KIT_MODE: 'terminal' })).toBe('terminal')
    expect(outputMode({}, { KIT_MODE: 'agent' })).toBe('agent')
    expect(outputMode({}, { KIT_MODE: 'loud' })).toBe('pipe')
  })
})

describe('jsonText', () => {
  test('indents for a person and stays on one line for an agent', () => {
    expect(jsonText({ a: [1] }, undefined, { stream: {}, env: {} })).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(jsonText({ a: [1] }, undefined, { stream: {}, env: { CLAUDECODE: '1' } })).toBe('{"a":[1]}')
  })
})

describe('help for an agent', () => {
  test('drops the examples and the instead-of line', () => {
    const before = process.env.CLAUDECODE

    process.env.CLAUDECODE = '1'

    try {
      expect(exampleRows(['a --b'])).toEqual([])
      expect(replacesRows('grep')).toEqual([])
    }
    finally {
      if (before === undefined)
        delete process.env.CLAUDECODE
      else
        process.env.CLAUDECODE = before
    }

    expect(exampleRows(['a --b'])).not.toEqual([])
  })
})

describe('isInteractive', () => {
  test('needs input and the prompt on a terminal', () => {
    expect(isInteractive({ stdin: { isTTY: true }, stderr: { isTTY: true } })).toBe(true)
    expect(isInteractive({ stdin: { isTTY: true }, stderr: { isTTY: false } })).toBe(false)
    expect(isInteractive({ stdin: {}, stderr: { isTTY: true } })).toBe(false)
    expect(isInteractive({})).toBe(false)
  })
})
