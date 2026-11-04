import type { Ranked } from './score'
import { rank } from './score'

export type Key = 'up' | 'down' | 'enter' | 'cancel' | 'erase' | 'clear' | 'word' | 'tab' | { text: string }

export interface State {
  /** The lines as read, which is what gets printed. */
  lines: readonly string[]
  /** The lines as searched and drawn: escapes and control characters out, so a position means the same in both. */
  items: readonly string[]
  query: string
  /** The lines the query matches, best first. */
  matches: Ranked[]
  /** Where the highlighted match stands in `matches`. */
  cursor: number
  /** The marked lines, by index in `lines`. */
  marked: ReadonlySet<number>
  multi: boolean
  prompt: string
  done: 'accept' | 'cancel' | undefined
}

// eslint-disable-next-line no-control-regex -- escape sequences are what it strips
const ANSI = /\x1B(?:\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[\x40-\x5A\x5C-\x5F])/g
// eslint-disable-next-line no-control-regex -- control characters are what it flattens
const CONTROL = /[\x00-\x1F\x7F-\x9F]/g
// eslint-disable-next-line no-control-regex -- control characters are what it tells apart
const IS_CONTROL = /[\x00-\x1F\x7F-\x9F]/

const PASTE_START = '\x1B[200~'
const PASTE_END = '\x1B[201~'
const LAST_WORD = /\S*\s*$/
// eslint-disable-next-line no-control-regex -- escape sequences are what it splits
const KEY_SEQUENCES = /\x1B\[[0-9;]*[A-Z~]|\x1BO[A-Z]|\x1B[\s\S]|[\s\S]/gu

const KEYS: Record<string, Key> = {
  '\x1B[A': 'up',
  '\x1BOA': 'up',
  '\x10': 'up',
  '\x1B[B': 'down',
  '\x1BOB': 'down',
  '\x0E': 'down',
  '\r': 'enter',
  '\n': 'enter',
  '\x03': 'cancel',
  '\x1B': 'cancel',
  '\x7F': 'erase',
  '\b': 'erase',
  '\x15': 'clear',
  '\x17': 'word',
  '\t': 'tab',
}

/** What a line looks like drawn and searched: no escapes, one space per tab or other control character. */
export function displayed(line: string): string {
  return line.replace(ANSI, '').replace(CONTROL, ' ')
}

/** The keys a chunk of terminal input holds, in order; keys nothing handles, such as Home or a function key, are dropped. A newline between the bracketed paste markers is text, not enter; `paste` carries an unfinished paste to the next chunk. */
export function parseKeys(input: string, paste = { active: false }): Key[] {
  return (input.match(KEY_SEQUENCES) ?? []).flatMap((sequence) => {
    const key = KEYS[sequence]

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
}

export function createState(lines: readonly string[], { multi = false, prompt = '> ', query = '' }: StateSettings = {}): State {
  const items = lines.map(displayed)

  return { lines, items, query, matches: rank(query, items), cursor: 0, marked: new Set(), multi, prompt, done: undefined }
}

function withQuery(state: State, query: string): State {
  return { ...state, query, matches: rank(query, state.items), cursor: 0 }
}

function move(state: State, by: number): State {
  return { ...state, cursor: Math.max(0, Math.min(state.matches.length - 1, state.cursor + by)) }
}

/** The index in `lines` of the highlighted match. */
export function highlighted(state: State): number | undefined {
  return state.matches[state.cursor]?.index
}

/** The next state for a key; once `done` is set nothing changes. */
export function press(state: State, key: Key): State {
  if (state.done !== undefined)
    return state

  if (typeof key === 'object')
    return withQuery(state, state.query + key.text)

  switch (key) {
    case 'up': return move(state, -1)
    case 'down': return move(state, 1)
    case 'cancel': return { ...state, done: 'cancel' }
    case 'erase': return withQuery(state, [...state.query].slice(0, -1).join(''))
    case 'clear': return withQuery(state, '')
    case 'word': return withQuery(state, state.query.replace(LAST_WORD, ''))
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

/** The lines to print once accepted: the marked ones in input order, or the highlighted one when none is marked. */
export function chosen(state: State): string[] {
  if (state.marked.size > 0)
    return state.lines.filter((_, index) => state.marked.has(index))

  const at = highlighted(state)

  return at === undefined ? [] : [state.lines[at]!]
}
