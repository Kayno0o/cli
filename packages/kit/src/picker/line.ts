// A line of text being typed, with a caret among its characters, edited as a shell's readline does.

export type EditKey = 'left' | 'right' | 'wordleft' | 'wordright' | 'linestart' | 'lineend' | 'erase' | 'delete' | 'word' | 'killword' | 'killnext' | 'clear' | 'killend'

const EDIT_KEYS: ReadonlySet<unknown> = new Set<EditKey>(['left', 'right', 'wordleft', 'wordright', 'linestart', 'lineend', 'erase', 'delete', 'word', 'killword', 'killnext', 'clear', 'killend'])

export function isEditKey(key: unknown): key is EditKey {
  return EDIT_KEYS.has(key)
}

// The text and the caret's index among its characters, a character of several code units counting as one.
export interface Line {
  text: string
  caret: number
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u
const SPACE = /\s/

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char)
}

// Back over what is no word, then over the word before: where Alt+B lands.
function wordStart(chars: readonly string[], from: number): number {
  let at = from

  while (at > 0 && !isWord(chars[at - 1]))
    at--

  while (at > 0 && isWord(chars[at - 1]))
    at--

  return at
}

// On over what is no word, then to the end of the word after: where Alt+F lands.
function wordEnd(chars: readonly string[], from: number): number {
  let at = from

  while (at < chars.length && !isWord(chars[at]))
    at++

  while (at < chars.length && isWord(chars[at]))
    at++

  return at
}

// Back over spaces, then over what is no space: what Ctrl+W takes, a URL whole.
function spacedStart(chars: readonly string[], from: number): number {
  let at = from

  while (at > 0 && SPACE.test(chars[at - 1] ?? ''))
    at--

  while (at > 0 && !SPACE.test(chars[at - 1] ?? ''))
    at--

  return at
}

function cut(chars: readonly string[], from: number, to: number): Line {
  return { text: [...chars.slice(0, from), ...chars.slice(to)].join(''), caret: from }
}

// The line once a key is pressed, typed text going in at the caret; Ctrl+U and Ctrl+K take what is before and after it.
export function editLine({ text, caret }: Line, key: EditKey | { text: string }): Line {
  const chars = [...text]
  const at = Math.min(Math.max(caret, 0), chars.length)

  if (typeof key === 'object') {
    const typed = [...key.text]

    return { text: [...chars.slice(0, at), ...typed, ...chars.slice(at)].join(''), caret: at + typed.length }
  }

  switch (key) {
    case 'left': return { text, caret: Math.max(at - 1, 0) }
    case 'right': return { text, caret: Math.min(at + 1, chars.length) }
    case 'wordleft': return { text, caret: wordStart(chars, at) }
    case 'wordright': return { text, caret: wordEnd(chars, at) }
    case 'linestart': return { text, caret: 0 }
    case 'lineend': return { text, caret: chars.length }
    case 'erase': return cut(chars, Math.max(at - 1, 0), at)
    case 'delete': return cut(chars, at, Math.min(at + 1, chars.length))
    case 'word': return cut(chars, spacedStart(chars, at), at)
    case 'killword': return cut(chars, wordStart(chars, at), at)
    case 'killnext': return cut(chars, at, wordEnd(chars, at))
    case 'clear': return cut(chars, 0, at)
    case 'killend': return cut(chars, at, chars.length)
  }
}

// What of a line fits in `room` columns with the caret in view: the text before the caret, the character under it (undefined at the end, where the caret takes a cell of its own) and the text after, an ellipsis standing for each side cut, and the column the caret lands on.
export function visible({ text, caret }: Line, room: number): { before: string, at: string | undefined, after: string, column: number } {
  const chars = [...text]
  const at = Math.min(Math.max(caret, 0), chars.length)
  const cells = at === chars.length ? [...chars, ' '] : chars
  const widths = cells.map(char => Bun.stringWidth(char))
  const width = (from: number, to: number) => widths.slice(from, to).reduce((sum, size) => sum + size, 0)
  const fits = (from: number, to: number) => (from > 0 ? 1 : 0) + width(from, to) + (to < cells.length ? 1 : 0) <= room
  let start = at
  let end = at + 1

  // As much as fits before the caret first, so typing at the end keeps the end of the line in view, then what fits after it.
  while (start > 0 && fits(start - 1, end))
    start--

  while (end < cells.length && fits(start, end + 1))
    end++

  const left = start > 0 ? '…' : ''
  const right = end < cells.length ? '…' : ''

  return { before: left + chars.slice(start, at).join(''), at: chars[at], after: chars.slice(at + 1, end).join('') + right, column: left.length + width(start, at) }
}
