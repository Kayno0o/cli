import type { EditKey } from './line'
import type { Ranked } from './score'
import { ANSI } from '../text'
import { editLine, isEditKey } from './line'
import { rank } from './score'

/** `ctrl` is a control key the caller asked for, named as `ctrl-d`. */
export type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'enter' | 'cancel' | 'tab' | 'help' | 'suspend' | EditKey | { text: string } | { ctrl: string }

/** A choice: the cells are drawn in columns and the first `searched` of them searched; the hidden fields are neither, and come back with the choice. */
export interface Row {
  hidden: string[]
  cells: string[]
  /** The text the query is matched against, in place of the first `searched` cells. */
  search?: string
}

export interface State {
  /** The rows as read, which is what gets printed. */
  rows: readonly Row[]
  /** The rows as drawn: the cells in columns, escapes and control characters out, so a position means the same here and in `styles`. */
  items: readonly string[]
  /** For each item the escapes setting the style of each of its characters, or undefined when it has none. */
  styles: readonly (readonly string[] | undefined)[]
  /** The part of each item the query is matched against: its first `searched` cells. */
  searchable: readonly string[]
  searched: number
  /** Lines shown under the prompt and the counts, escapes allowed. */
  header: string
  /** Control keys that end the pick, named as `ctrl-d`. */
  expect: readonly string[]
  /** The expected key that ended the pick, empty for enter. */
  key: string
  /** A note shown beside the counts, such as a reload in progress. */
  status: string
  query: string
  /** Where the caret stands among the query's characters. */
  caret: number
  /** What the last kills took from the query, which ctrl-y puts back, and whether the key before was one of them. */
  killed: string
  chained: boolean
  /** The rows the query matches, best first. */
  matches: Ranked[]
  /** Where the highlighted match stands in `matches`. */
  cursor: number
  /** Whether the key legend is drawn in place of the list. */
  help: boolean
  /** How many rows page up and page down move by, the list rows on screen. */
  page: number
  /** The marked rows, by index in `rows`. */
  marked: ReadonlySet<number>
  multi: boolean
  prompt: string
  done: 'accept' | 'cancel' | undefined
}

// eslint-disable-next-line no-control-regex -- control characters are what it flattens
const CONTROL = /[\x00-\x1F\x7F-\x9F]/g
// eslint-disable-next-line no-control-regex -- control characters are what it tells apart
const IS_CONTROL = /[\x00-\x1F\x7F-\x9F]/
// eslint-disable-next-line no-control-regex -- a style escape is what it recognizes
const SGR = /^\x1B\[[0-9;]*m$/
// eslint-disable-next-line no-control-regex -- a style reset is what it recognizes
const RESET = /^\x1B\[0?m$/

const COLUMN_GAP = 2
const PASTE_START = '\x1B[200~'
const PASTE_END = '\x1B[201~'

// eslint-disable-next-line no-control-regex -- escape sequences are what it splits
const KEY_SEQUENCES = /\x1B\[<[0-9;]*[A-Za-z]|\x1B\[[0-9;]*[A-Z~]|\x1BO[A-Z]|\x1B[\s\S]|[\s\S]/gu
// An SGR mouse report: the button, then the column and row; 64 and 65 are the wheel up and down.
// eslint-disable-next-line no-control-regex -- an escape sequence is what it recognizes
const MOUSE = /^\x1B\[<(\d+);\d+;\d+[a-z]$/i
const WHEEL_LINES = 3

const KEYS: Record<string, Key> = {
  '\x1B[A': 'up',
  '\x1BOA': 'up',
  '\x10': 'up',
  '\x1B[B': 'down',
  '\x1BOB': 'down',
  '\x0E': 'down',
  '\x1B[5~': 'pageup',
  '\x1B[6~': 'pagedown',
  '\x1B[H': 'home',
  '\x1B[1~': 'home',
  '\x1BOH': 'home',
  '\x1B[F': 'end',
  '\x1B[4~': 'end',
  '\x1BOF': 'end',
  '\r': 'enter',
  '\n': 'enter',
  '\x03': 'cancel',
  '\x1B': 'cancel',
  '\x1B[D': 'left',
  '\x1BOD': 'left',
  '\x1B[C': 'right',
  '\x1BOC': 'right',
  // Ctrl or Alt with an arrow, and Alt+B and Alt+F as readline has them.
  '\x1B[1;5D': 'wordleft',
  '\x1B[1;3D': 'wordleft',
  '\x1Bb': 'wordleft',
  '\x1B[1;5C': 'wordright',
  '\x1B[1;3C': 'wordright',
  '\x1Bf': 'wordright',
  '\x01': 'linestart',
  '\x05': 'lineend',
  '\x7F': 'erase',
  '\x1B[3~': 'delete',
  // Ctrl+Backspace, as kitty, xterm and tmux send it, and Alt+Backspace.
  '\b': 'killword',
  '\x1B\x7F': 'killword',
  // Ctrl+Delete and Alt+D.
  '\x1B[3;5~': 'killnext',
  '\x1Bd': 'killnext',
  '\x15': 'clear',
  '\x0B': 'killend',
  '\x17': 'word',
  '\x19': 'yank',
  '\x1A': 'suspend',
  '\t': 'tab',
  '\x1F': 'help',
  '\x1BOP': 'help',
  '\x1B[11~': 'help',
}

/** The control keys a caller can ask for, `ctrl-a` to `ctrl-z` but those standing for tab, enter, backspace and cancel. */
export const CTRL_KEY = /^ctrl-[abd-gkln-z]$/

function repeat<T = string>(value: T, count: number): T[] {
  return Array.from<T>({ length: count }).fill(value)
}

/** What a line looks like drawn and searched: no escapes, one space per tab or other control character. */
export function displayed(line: string): string {
  return line.replace(ANSI, '').replace(CONTROL, ' ')
}

export interface Styled {
  text: string
  styles: string[] | undefined
}

/** A line as drawn with the style each of its characters had: only the color and weight escapes are kept, the others being dropped, and control characters flattened to a space. */
export function styled(line: string): Styled {
  let text = ''
  const styles: string[] = []
  let active = ''
  let colored = false
  let last = 0

  function add(chunk: string): void {
    const flat = chunk.replace(CONTROL, ' ')

    text += flat
    colored ||= active !== '' && flat !== ''
    styles.push(...repeat(active, flat.length))
  }

  for (const found of line.matchAll(ANSI)) {
    add(line.slice(last, found.index))
    last = found.index + found[0].length

    if (SGR.test(found[0]))
      active = RESET.test(found[0]) ? '' : active + found[0]
  }

  add(line.slice(last))

  return { text, styles: colored ? styles : undefined }
}

interface Laid {
  text: string
  styles: string[] | undefined
  searchable: string
}

/** The rows with their cells in columns, and the part of each the query is matched against. A row of one cell is its line as it is. */
function lay(rows: readonly Row[], searched: number): Laid[] {
  const parsed = rows.map(row => row.cells.map(styled))
  const widths = (parsed[0] ?? []).map((_, column) => Math.max(...parsed.map(cells => Bun.stringWidth(cells[column]?.text ?? ''))))

  return parsed.map((cells, at) => {
    let text = ''
    const styles: string[] = []
    let colored = false
    let searchEnd = 0

    for (const [column, cell] of cells.entries()) {
      const last = column === cells.length - 1
      const shown = cells.length > 1 && last ? cell.text.trimEnd() : cell.text

      text += shown
      colored ||= cell.styles !== undefined

      styles.push(...cell.styles?.slice(0, shown.length) ?? repeat('', shown.length))

      if (column < searched)
        searchEnd = cells.length > 1 ? text.trimEnd().length : text.length

      if (!last) {
        const pad = widths[column]! - Bun.stringWidth(cell.text) + COLUMN_GAP

        text += ' '.repeat(pad)
        styles.push(...repeat('', pad))
      }
    }

    return { text, styles: colored ? styles : undefined, searchable: rows[at]!.search ?? text.slice(0, searchEnd) }
  })
}

/** The keys a chunk of terminal input holds, in order; keys nothing handles, such as a function key, are dropped. A newline between the bracketed paste markers is text, not enter; `paste` carries an unfinished paste to the next chunk. A control key named in `ctrls` (`ctrl-d`) comes back as `{ ctrl }` in place of what it does otherwise, ctrl-p and ctrl-n moving among the rows. */
export function parseKeys(input: string, paste = { active: false }, ctrls: readonly string[] = []): Key[] {
  const codes = new Map(ctrls.map(name => [String.fromCharCode(name.codePointAt(name.length - 1)! - 96), name]))

  return (input.match(KEY_SEQUENCES) ?? []).flatMap((sequence) => {
    const wheel = MOUSE.exec(sequence)?.[1]

    if (wheel !== undefined)
      return repeat<Key>(wheel === '64' ? 'up' : 'down', wheel === '64' || wheel === '65' ? WHEEL_LINES : 0)

    const named = codes.get(sequence)
    const key = named === undefined ? KEYS[sequence] : { ctrl: named }

    if (sequence === PASTE_START || sequence === PASTE_END) {
      paste.active = sequence === PASTE_START

      return []
    }

    if (paste.active && (sequence === '\r' || sequence === '\n'))
      return []

    if (key !== undefined)
      return [key]

    return IS_CONTROL.test(sequence) || sequence.startsWith('\x1B') ? [] : [{ text: sequence }]
  })
}

export interface StateSettings {
  multi?: boolean
  prompt?: string
  query?: string
  header?: string | undefined
  expect?: readonly string[] | undefined
  /** How many leading cells are searched, all of them by default. */
  searched?: number | undefined
}

/** A line is a row of one cell with nothing hidden. */
export function createState(rows: readonly (string | Row)[], { multi = false, prompt = '> ', query = '', header = '', expect = [], searched = Number.POSITIVE_INFINITY }: StateSettings = {}): State {
  const state: State = { rows: [], items: [], styles: [], searchable: [], searched, header, expect, key: '', status: '', query, caret: [...query].length, killed: '', chained: false, matches: [], cursor: 0, help: false, page: 10, marked: new Set(), multi, prompt, done: undefined }

  return withRows(state, rows)
}

/** The same state over other rows, the query kept and the marks dropped; the cursor stays on its position when the new list reaches it. */
export function withRows(state: State, rows: readonly (string | Row)[], header = state.header): State {
  const cells = rows.map(row => typeof row === 'string' ? { hidden: [], cells: [row] } : row)
  const laid = lay(cells, state.searched)
  const searchable = laid.map(row => row.searchable)
  const matches = rank(state.query, searchable)

  return { ...state, rows: cells, items: laid.map(row => row.text), styles: laid.map(row => row.styles), searchable, header, matches, cursor: Math.max(0, Math.min(matches.length - 1, state.cursor)), marked: new Set() }
}

// The query once a key edits it, the matches ranked again only when its text changed.
function withQuery(state: State, key: EditKey | { text: string }): State {
  const { text, caret, killed = '', chained = false } = editLine({ text: state.query, caret: state.caret, killed: state.killed, chained: state.chained }, key)

  return text === state.query ? { ...state, caret, killed, chained } : { ...state, query: text, caret, killed, chained, matches: rank(text, state.searchable), cursor: 0 }
}

function move(state: State, by: number): State {
  return { ...state, cursor: Math.max(0, Math.min(state.matches.length - 1, state.cursor + by)) }
}

/** The index in `rows` of the highlighted match. */
export function highlighted(state: State): number | undefined {
  return state.matches[state.cursor]?.index
}

/** The next state for a key; once `done` is set nothing changes. An expected key ends the pick whether a row is highlighted or not. */
export function press(state: State, key: Key): State {
  if (state.done !== undefined)
    return state

  if (state.chained && typeof key !== 'object' && !isEditKey(key))
    state = { ...state, chained: false }

  // The legend covers the list, so the key that reads it is the one that closes it.
  if (state.help)
    return { ...state, help: false }

  if (typeof key === 'object') {
    if ('text' in key)
      return withQuery(state, key)

    return state.expect.includes(key.ctrl) ? { ...state, done: 'accept', key: key.ctrl } : state
  }

  if (isEditKey(key))
    return withQuery(state, key)

  switch (key) {
    case 'up': return move(state, -1)
    case 'down': return move(state, 1)
    case 'pageup': return move(state, -state.page)
    case 'pagedown': return move(state, state.page)
    case 'home': return move(state, -state.matches.length)
    case 'end': return move(state, state.matches.length)
    case 'cancel': return { ...state, done: 'cancel' }
    case 'help': return { ...state, help: true }
    // The terminal stops the process for it, the state staying as it was.
    case 'suspend': return state

    case 'enter': return state.matches.length === 0 && state.marked.size === 0 ? state : { ...state, done: 'accept' }
    case 'tab': {
      const at = highlighted(state)

      if (!state.multi || at === undefined)
        return state

      const marked = new Set(state.marked)

      if (!marked.delete(at))
        marked.add(at)

      return move({ ...state, marked }, 1)
    }
  }
}

/** The rows to print once accepted: the marked ones in input order, or the highlighted one when none is marked. */
export function chosen(state: State): Row[] {
  if (state.marked.size > 0)
    return state.rows.filter((_, index) => state.marked.has(index))

  const at = highlighted(state)

  return at === undefined ? [] : [state.rows[at]!]
}
