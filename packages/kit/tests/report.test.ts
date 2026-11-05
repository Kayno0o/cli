import { describe, expect, it } from 'bun:test'
import { changeLines, planned, unknownHint } from '../src/report'

const terminal = { isTTY: true }
const plain = { isTTY: false }

describe('changeLines', () => {
  it('signs each change and dims the detail, uncoloured off a terminal', () => {
    const lines = changeLines([{ kind: 'add', label: 'users.email' }, { kind: 'remove', label: 'users.old' }, { kind: 'change', label: 'users.name', detail: 'text → varchar' }], plain, {})

    expect(lines).toEqual(['+ users.email', '- users.old', '~ users.name  text → varchar'])
  })

  it('colours the sign on a terminal', () => {
    expect(changeLines([{ kind: 'add', label: 'a' }], terminal, { KIT_MODE: 'terminal' })[0]).toContain('\x1B[')
  })
})

describe('planned', () => {
  it('reads would: off a terminal and draws the plan glyph on one', () => {
    expect(planned('create alice', '(admin)', plain, {})).toBe('would: create alice (admin)')
    expect(planned('create alice', undefined, terminal, { KIT_MODE: 'terminal' })).toContain('◇')
  })
})

describe('unknownHint', () => {
  it('suggests the closest name, else lists the known ones with a count of the rest', () => {
    expect(unknownHint('alise', ['alice', 'bob'])).toBe('did you mean alice?')
    expect(unknownHint('zzzzzz', ['a', 'b', 'c'], 2)).toBe('one of: a, b and 1 more')
    expect(unknownHint('x', [])).toBeUndefined()
  })
})
