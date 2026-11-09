import type { Key, State } from '../../src/picker/state'
import { describe, expect, test } from 'bun:test'
import { chosen, createState, displayed, highlighted, parseKeys, press, withRows } from '../../src/picker/state'

function typed(state: State, ...keys: (Key | string)[]): State {
  return keys.reduce<State>((current, key) => typeof key === 'string' && key.length === 1 && key !== '\n' ? press(current, { text: key }) : press(current, key as Key), state)
}

const LINES = ['apple', 'banana', 'cherry', 'apricot']

const lines = (state: State): string[] => chosen(state).map(row => row.cells[0]!)

describe('parseKeys', () => {
  test('reads the wheel as three rows and drops the other mouse reports', () => {
    expect(parseKeys('\x1B[<64;12;5M\x1B[<65;3;9M\x1B[<0;3;9M\x1B[<0;3;9m')).toEqual(['up', 'up', 'up', 'down', 'down', 'down'])
  })

  test('reads ctrl-/ and the f1 key as the help key', () => {
    expect(parseKeys('\x1F\x1BOP\x1B[11~')).toEqual(['help', 'help', 'help'])
  })

  test('reads the keys the picker handles', () => {
    expect(parseKeys('\x1B[A\x1B[B\x10\x0E\r\x03\x7F\t\x15\x17')).toEqual(['up', 'down', 'up', 'down', 'enter', 'cancel', 'erase', 'tab', 'clear', 'word'])
  })

  test('reads Ctrl+Backspace and Alt+Backspace as erasing a word', () => {
    expect(parseKeys('\b\x1B\x7F')).toEqual(['word', 'word'])
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
    expect(lines(state)).toEqual(['banana'])
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
    expect(lines(state)).toEqual([])
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
    expect(lines(press(state, 'enter'))).toEqual(['apple', 'cherry'])
  })

  test('tab on a marked line unmarks it, and enter with no mark picks the highlighted line', () => {
    let state = createState(LINES, { multi: true })

    state = typed(state, 'tab', 'up', 'tab')
    expect(state.marked.size).toBe(0)
    expect(lines(typed(state, 'enter'))).toEqual(['banana'])
  })

  test('--query starts filtered', () => {
    expect(createState(LINES, { query: 'ch' }).matches.map(match => LINES[match.index])).toEqual(['cherry'])
  })

  test('prints the line as read, not as drawn', () => {
    const state = typed(createState(['\x1B[31mred\x1B[0m']), 'enter')

    expect(state.items).toEqual(['red'])
    expect(lines(state)).toEqual(['\x1B[31mred\x1B[0m'])
  })
})

const ROWS = [
  { hidden: ['id-1', 'x'], cells: ['install-hooks', 'adds the hooks'] },
  { hidden: ['id-2', 'y'], cells: ['install', 'adds the packages'] },
  { hidden: ['id-3', 'z'], cells: ['doctor', 'checks install'] },
]

describe('rows', () => {
  test('lays the cells in columns and keeps the hidden fields out of them', () => {
    const state = createState(ROWS)

    expect(state.items).toEqual(['install-hooks  adds the hooks', 'install        adds the packages', 'doctor         checks install'])
  })

  test('only the first searched cells are matched, the shortest one winning a tie', () => {
    const state = createState(ROWS, { searched: 1, query: 'install' })

    expect(state.matches.map(match => ROWS[match.index]!.hidden[0])).toEqual(['id-2', 'id-1'])
    expect(createState(ROWS, { query: 'install' }).matches).toHaveLength(3)
  })

  test('the hidden fields come back with the row', () => {
    const state = typed(createState(ROWS, { searched: 1, query: 'doc' }), 'enter')

    expect(chosen(state)).toEqual([ROWS[2]!])
  })

  test('keeps the colors of a cell apart from the text', () => {
    const state = createState([{ hidden: [], cells: ['\x1B[31mred\x1B[0m', 'plain'] }])

    expect(state.items).toEqual(['red  plain'])
    expect(state.styles[0]).toEqual(['\x1B[31m', '\x1B[31m', '\x1B[31m', '', '', '', '', '', '', ''])
    expect(createState(['plain']).styles).toEqual([undefined])
  })
})

describe('expected keys', () => {
  test('a control key named by the caller is reported as such, even over ctrl-n', () => {
    expect(parseKeys('\x04\x0E\x12', { active: false }, ['ctrl-d', 'ctrl-n'])).toEqual([{ ctrl: 'ctrl-d' }, { ctrl: 'ctrl-n' }])
    expect(parseKeys('\x0E', { active: false })).toEqual(['down'])
  })

  test('an expected key ends the pick with the key, a row or not', () => {
    const state = createState(ROWS, { expect: ['ctrl-d'], query: 'zzz' })
    const done = press(state, { ctrl: 'ctrl-d' })

    expect(done).toMatchObject({ done: 'accept', key: 'ctrl-d', query: 'zzz' })
    expect(chosen(done)).toEqual([])
    expect(press(createState(ROWS), { ctrl: 'ctrl-d' }).done).toBeUndefined()
  })
})

describe('withRows', () => {
  test('swaps the rows and keeps the query', () => {
    const state = withRows(createState(ROWS, { query: 'doc' }), [{ hidden: ['n'], cells: ['docker'] }, { hidden: ['m'], cells: ['other'] }], 'fresh')

    expect(state.query).toBe('doc')
    expect(state.header).toBe('fresh')
    expect(state.matches.map(match => state.rows[match.index]!.hidden[0])).toEqual(['n'])
  })
})
