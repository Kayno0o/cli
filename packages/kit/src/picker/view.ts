import type { State } from './state'
import { styled } from './state'

/** How a part of the picker is drawn: the kit's roles, or plain text. */
export interface Theme {
  accent: (text: string) => string
  label: (text: string) => string
  value: (text: string) => string
  id: (text: string) => string
  /** How the characters a query matched are drawn, the accent by default. */
  match?: (text: string) => string
}

export interface Size {
  columns: number
  rows: number
}

/** Lines, or a share of the terminal's rows. */
export type Height = { lines: number } | { percent: number }

/** Beside the list, or under it. */
export type PreviewPosition = 'right' | 'down'

export interface Layout {
  height: number
  /** The rows of the list area, the preview below it taking the rest. */
  listHeight: number
  listWidth: number
  /** Zero when there is no room or no command for a preview pane on the right. */
  previewWidth: number
  /** Zero when there is no room or no command for a preview pane below, else its rows with its separator. */
  previewHeight: number
}

const MIN_HEIGHT = 4
const PREVIEW_MIN_COLUMNS = 80
const PREVIEW_MIN_ROWS = 10
const PREVIEW_SHARE = 0.4
const RESET = '\x1B[0m'
const SEPARATOR = ' │ '
const HEIGHT = /^(\d+)(%?)$/

export const DEFAULT_HEIGHT: Height = { percent: 40 }

export function parseHeight(text: string): Height | undefined {
  const found = HEIGHT.exec(text)

  if (found === null || Number(found[1]) < 1)
    return undefined

  return found[2] === '%' ? { percent: Math.min(100, Number(found[1])) } : { lines: Number(found[1]) }
}

/** The region the picker draws in: at least four lines unless the terminal has fewer, never more than the terminal. */
export function layoutFor(size: Size, height: Height, previewing: boolean, position: PreviewPosition = 'right'): Layout {
  const wanted = 'lines' in height ? height.lines : Math.round(size.rows * height.percent / 100)
  const rows = Math.min(size.rows, Math.max(MIN_HEIGHT, wanted))

  if (position === 'down') {
    const previewHeight = previewing && rows >= PREVIEW_MIN_ROWS ? Math.round(rows * PREVIEW_SHARE) : 0

    return { height: rows, listHeight: rows - previewHeight, listWidth: size.columns, previewWidth: 0, previewHeight }
  }

  const split = previewing && size.columns >= PREVIEW_MIN_COLUMNS
  const listWidth = split ? Math.floor(size.columns / 2) : size.columns

  return { height: rows, listHeight: rows, listWidth, previewWidth: split ? size.columns - listWidth - SEPARATOR.length : 0, previewHeight: 0 }
}

interface Fitted {
  text: string
  width: number
}

/** Text cut to a width with a trailing ellipsis, each character at a position in `marked` drawn with `mark`, the ones with a style in `styles` with it, and the others with `plain`. */
function fit(text: string, width: number, plain: (text: string) => string, mark: (text: string) => string = plain, marked: ReadonlySet<number> = new Set(), styles?: readonly string[]): Fitted {
  const room = Bun.stringWidth(text) > width ? width - 1 : width
  let out = ''
  let used = 0
  let at = 0

  for (const char of text) {
    const size = Bun.stringWidth(char)

    if (used + size > room)
      break

    const style = marked.has(at) ? '' : styles?.[at] ?? ''

    out += style === '' ? (marked.has(at) ? mark : plain)(char) : `${style}${char}${RESET}`
    used += size
    at += char.length
  }

  if (room < width) {
    out += plain('…')
    used += 1
  }

  return { text: out, width: used }
}

const identity = (text: string): string => text

/** A line that may carry style escapes, cut to a width. */
function fitStyled(line: string, width: number, plain: (text: string) => string = identity): Fitted {
  const { text, styles } = styled(line)

  return fit(text, width, plain, plain, new Set(), styles)
}

/** The column the query's caret sits at, one-based, on the first line. */
export function caretColumn(state: State, layout: Layout): number {
  return Math.min(layout.listWidth, Bun.stringWidth(state.prompt) + Bun.stringWidth(state.query) + 1)
}

/** The keys the picker answers to, drawn in place of the list while help is open, short enough for the smallest box. */
function helpLines(state: State, layout: Layout, theme: Theme): Fitted[] {
  const lines = [
    'type to filter, up, down, ctrl-p, ctrl-n, pgup, pgdn, home, end move',
    `enter picks${state.multi ? ', tab marks' : ''}, ctrl-u clears the query, ctrl-w a word, esc or ctrl-c cancels`,
    ...state.expect.length > 0 ? [`${state.expect.join(', ')} end the pick as this command asks`] : [],
  ]
  const title = 'keys, any key closes this help'

  return [{ text: theme.accent(title), width: title.length }, ...lines.map(line => fit(`  ${line}`, layout.listWidth, theme.label))]
}

function listLines(state: State, layout: Layout, theme: Theme): Fitted[] {
  if (state.help)
    return helpLines(state, layout, theme)

  const header = state.header === '' ? [] : state.header.split('\n').map(line => fitStyled(line, layout.listWidth, theme.label))
  const rows = Math.max(1, layout.listHeight - 2 - header.length)
  const prefixWidth = state.multi ? 4 : 2
  const top = Math.max(0, Math.min(state.cursor - Math.floor(rows / 2), state.matches.length - rows))
  const marks = (state.marked.size > 0 ? ` (${state.marked.size} marked)` : '') + (state.status === '' ? '' : ` ${state.status}`)
  const promptWidth = Bun.stringWidth(state.prompt)
  const query = fit(state.query, Math.max(1, layout.listWidth - promptWidth), identity)
  // Where the highlight stands when the list is longer than the box, as there is no scrollbar to show it.
  const place = state.matches.length > rows ? ` (${state.cursor + 1} of ${state.matches.length})` : ''
  const count = fit(`  ${state.matches.length}/${state.items.length}${place}${marks}  ctrl-/ keys`, layout.listWidth, theme.label)
  const lines: Fitted[] = [{ text: theme.accent(state.prompt) + query.text, width: promptWidth + query.width }, count, ...header]

  if (state.matches.length === 0)
    lines.push(fit('  no match', layout.listWidth, theme.label))

  for (const [offset, match] of state.matches.slice(top, top + rows).entries()) {
    const current = top + offset === state.cursor
    const pointer = current ? theme.accent('❯') : ' '
    const mark = state.multi ? `${state.marked.has(match.index) ? theme.id('●') : ' '} ` : ''
    const text = fit(state.items[match.index]!, layout.listWidth - prefixWidth, current ? theme.value : identity, theme.match ?? theme.accent, new Set(match.positions), state.styles[match.index])

    lines.push({ text: `${pointer} ${mark}${text.text}`, width: prefixWidth + text.width })
  }

  return lines
}

/** The lines drawn for a state, exactly `layout.height` of them, the preview text in a pane on the right when there is one. */
export function render(state: State, layout: Layout, theme: Theme, preview: readonly string[] = []): string[] {
  const left = listLines(state, layout, theme)

  return Array.from({ length: layout.height }, (_, row) => {
    if (row >= layout.listHeight)
      return row === layout.listHeight ? theme.label('─'.repeat(layout.listWidth)) : fitStyled(preview[row - layout.listHeight - 1] ?? '', layout.listWidth).text

    const list = left[row] ?? { text: '', width: 0 }

    if (layout.previewWidth === 0)
      return list.text

    return `${list.text}${' '.repeat(Math.max(0, layout.listWidth - list.width))}${theme.label(SEPARATOR)}${fitStyled(preview[row] ?? '', layout.previewWidth).text}`
  })
}
