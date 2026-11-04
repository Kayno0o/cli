import type { Key, State } from '../src/state'
import { describe, expect, test } from 'bun:test'
import { chosen, createState, displayed, highlighted, parseKeys, press } from '../src/state'

function typed(state: State, ...keys: (Key | string)[]): State {
  return keys.reduce<State>((current, key) => typeof key === 'string' && key.length === 1 && key !== '\n' ? press(current, { text: key }) : press(current, key as Key), state)
}

const LINES = ['apple', 'banana', 'cherry', 'apricot']

describe('parseKeys', () => {
  test('reads the keys the picker handles', () => {
    expect(parseKeys('\x1B[A\x1B[B\x10\x0E\r\x03\x7F\t\x15\x17')).toEqual(['up', 'down', 'up', 'down', 'enter', 'cancel', 'erase', 'tab', 'clear', 'word'])
  })

  test('a lone escape cancels while a sequence it starts does not', () => {
    expect(parseKeys('\x1B')).toEqual(['cancel'])
    expect(parseKeys('\x1B[1;5C')).toEqual([])
  })

  test('an Alt+key (escape then a letter) is dropped instead of cancelling', () => {
    expect(parseKeys('\x1Bb')).toEqual([])
    expect(parseKeys('\x1Bba')).toEqual([{ text: 'a' }])
  })

  test('a newline inside bracketed pasted text is no enter', () => {
    expect(parseKeys('\x1B[200~foo\nbar\n\x1B[201~')).toEqual([{ text: 'f' }, { text: 'o' }, { text: 'o' }, { text: 'b' }, { text: 'a' }, { text: 'r' }])
    expect(parseKeys('\x1B[200~a\n\x1B[201~\r')).toEqual([{ text: 'a' }, 'enter'])
    expect(parseKeys('\r')).toEqual(['enter'])
  })

  test('a paste split across chunks stays a paste', () => {
    const paste = { active: false }

    expect(parseKeys('\x1B[200~a\n', paste)).toEqual([{ text: 'a' }])
    expect(parseKeys('b\n\x1B[201~\r', paste)).toEqual([{ text: 'b' }, 'enter'])
  })

  test('keeps the enter after text typed or piped in the same chunk', () => {
    expect(parseKeys('abc\r')).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }, 'enter'])
  })

  test('keeps printable text, pasted or typed, and drops unknown control keys', () => {
    expect(parseKeys('ab é\x01')).toEqual([{ text: 'a' }, { text: 'b' }, { text: ' ' }, { text: 'é' }])
  })
})

describe('displayed', () => {
  test('strips escapes and flattens control characters', () => {
    expect(displayed('\x1B[31mred\x1B[0m\tx')).toBe('red x')
  })
})

describe('press', () => {
  test('typing filters and resets the cursor to the best match', () => {
    const state = typed(createState(LINES), 'down', 'down', { text: 'a' }, { text: 'p' })

    expect(state.query).toBe('ap')
    expect(state.matches.map(match => LINES[match.index])).toEqual(['apple', 'apricot'])
    expect(state.cursor).toBe(0)
  })

  test('erase, clear and word shorten the query', () => {
    const state = createState(LINES, { query: 'foo bar' })

    expect(press(state, 'erase').query).toBe('foo ba')
    expect(press(state, 'word').query).toBe('foo ')
    expect(press(press(state, 'word'), 'word').query).toBe('')
    expect(press(state, 'clear').query).toBe('')
    expect(press(createState(LINES), 'erase').query).toBe('')
  })

  test('the cursor stays inside the matches', () => {
    const state = createState(LINES)

    expect(press(state, 'up').cursor).toBe(0)
    expect(typed(state, 'down', 'down', 'down', 'down', 'down').cursor).toBe(3)
  })

  test('enter accepts the highlighted line', () => {
    const state = typed(createState(LINES), 'down', 'enter')

    expect(state.done).toBe('accept')
    expect(chosen(state)).toEqual(['banana'])
  })

  test('esc and ctrl-c cancel, and a finished state ignores keys', () => {
    const state = press(createState(LINES), 'cancel')

    expect(state.done).toBe('cancel')
    expect(press(state, { text: 'x' })).toBe(state)
  })

  test('an empty list ignores enter and has nothing highlighted', () => {
    const state = typed(createState(LINES), { text: 'z' }, { text: 'z' })

    expect(state.matches).toEqual([])
    expect(highlighted(state)).toBeUndefined()
    expect(press(state, 'enter')).toBe(state)
    expect(press(state, 'down')).toMatchObject({ cursor: 0 })
    expect(chosen(state)).toEqual([])
    expect(press(state, 'tab')).toBe(state)
  })

  test('tab does nothing without --multi', () => {
    const state = createState(LINES)

    expect(press(state, 'tab')).toBe(state)
  })

  test('with --multi tab marks and moves on, marks survive a new query, enter prints them in input order', () => {
    let state = createState(LINES, { multi: true })

    state = typed(state, 'down', 'down', 'tab')
    expect([...state.marked]).toEqual([2])
    expect(state.cursor).toBe(3)

    state = typed(state, 'up', 'up', 'up', 'tab')
    expect([...state.marked].sort()).toEqual([0, 2])

    state = typed(state, { text: 'zz' })
    expect(state.matches).toEqual([])
    expect(press(state, 'enter').done).toBe('accept')
    expect(chosen(press(state, 'enter'))).toEqual(['apple', 'cherry'])
  })

  test('tab on a marked line unmarks it, and enter with no mark picks the highlighted line', () => {
    let state = createState(LINES, { multi: true })

    state = typed(state, 'tab', 'up', 'tab')
    expect(state.marked.size).toBe(0)
    expect(chosen(typed(state, 'enter'))).toEqual(['banana'])
  })

  test('--query starts filtered', () => {
    expect(createState(LINES, { query: 'ch' }).matches.map(match => LINES[match.index])).toEqual(['cherry'])
  })

  test('prints the line as read, not as drawn', () => {
    const state = typed(createState(['\x1B[31mred\x1B[0m']), 'enter')

    expect(state.items).toEqual(['red'])
    expect(chosen(state)).toEqual(['\x1B[31mred\x1B[0m'])
  })
})
