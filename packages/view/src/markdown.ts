import type { Align } from '@kaynooo/cli-kit'
import type { Theme } from './theme'
import { stripAnsi, textWidth } from '@kaynooo/cli-kit'
import { highlight, languageOf } from './code'

export interface RenderSettings {
  theme: Theme
  // Columns a line may take.
  width: number
}

// A line that holds text to wrap is `FIRST <prefix of its first line> REST <prefix of the others> BODY <text>`. Containers indent the lines they hold without knowing how far the text will reach, so the wrapping waits until the whole document is built.
const FIRST = '\u0001'
const REST = '\u0002'
const BODY = '\u0003'
// Starts a list nested in a list item, so the item can tell its own text from it.
const NESTED = '\u0005'
const CELL = '\u0006'
const ROW = '\u0007'
// Starts a block, so a tight list item can tell its text from the block that follows it.
const BLOCK = '\u0008'

const MAX_RULE = 60
// How far the rules around a code block reach at most, so a wide block does not stretch them across the screen.
const MAX_CODE_RULE = 5
const MIN_CODE_RULE = 4
// The shade of a heading by level along the gradient, the deeper ones toward its end.
const HEADING_SHADES = [0, 0.35, 0.7, 1]
const MIN_ROOM = 20
const MIN_COLUMN = 8
// How much wider than its average cell a column starts out.
const TYPICAL = 1.4
const COLUMN_GAP = 2
const TRAILING_BREAKS = /\n+$/

function block(text: string): string {
  return `${BLOCK}${text}`
}

function reflow(text: string, first = '', rest = ''): string {
  return `${FIRST}${first}${REST}${rest}${BODY}${text}`
}

function trimmed(block: string): string {
  return block.replace(TRAILING_BREAKS, '')
}

// `first` goes before the block's first line, `rest` before every other; a line to wrap carries them in its own prefixes.
function indent(block: string, first: string, rest: string): string {
  return block.split('\n').map((line, index) => {
    const lead = index === 0 ? first : rest

    if (!line.startsWith(FIRST))
      return `${lead}${line}`

    const middle = line.indexOf(REST)
    const body = line.indexOf(BODY)

    return `${FIRST}${lead}${line.slice(1, middle)}${REST}${rest}${line.slice(middle + 1, body)}${BODY}${line.slice(body + 1)}`
  }).join('\n')
}

// Wraps every line to wrap to `width`, each wrapped line behind its prefix.
function finish(block: string, width: number): string {
  return block.split('\n').flatMap((line) => {
    if (!line.startsWith(FIRST))
      return [line.trimEnd()]

    const middle = line.indexOf(REST)
    const body = line.indexOf(BODY)
    const first = line.slice(1, middle)
    const rest = line.slice(middle + 1, body)
    const room = Math.max(width - Math.max(textWidth(first), textWidth(rest)), MIN_ROOM)

    return Bun.wrapAnsi(line.slice(body + 1), room).split('\n').map((wrapped, index) => `${index === 0 ? first : rest}${wrapped}`.trimEnd())
  }).join('\n')
}

// The columns' widths. A table that fits keeps each column as wide as its widest cell; otherwise a column starts at what its cells typically take, so one long cell wraps instead of widening its whole column, the room left goes to the columns with cells longer than that, and the widest are narrowed one character at a time if even the typical widths do not fit.
function columnWidths(rows: string[][], width: number): number[] {
  const longest = rows[0]?.map((_, column) => Math.max(...rows.map(row => textWidth(row[column] ?? '')))) ?? []
  const gaps = COLUMN_GAP * Math.max(0, longest.length - 1)
  const sum = (list: number[]) => list.reduce((total, each) => total + each, 0)

  if (sum(longest) + gaps <= width)
    return longest

  const typical = longest.map((most, column) => Math.min(most, Math.max(MIN_COLUMN, Math.ceil(TYPICAL * sum(rows.map(row => textWidth(row[column] ?? ''))) / rows.length))))
  const widths = [...typical]
  const room = width - gaps - sum(typical)
  const wanting = longest.map((most, column) => most - typical[column]!)

  if (room > 0 && sum(wanting) > 0) {
    for (const [column, want] of wanting.entries())
      widths[column]! += Math.min(want, Math.floor(room * want / sum(wanting)))

    const left = width - gaps - sum(widths)
    const hungriest = wanting.indexOf(Math.max(...wanting))

    widths[hungriest]! += Math.max(0, Math.min(left, longest[hungriest]! - widths[hungriest]!))
  }

  const total = () => sum(widths) + gaps

  while (total() > width) {
    const widest = widths.indexOf(Math.max(...widths))

    if ((widths[widest] ?? 0) <= MIN_COLUMN)
      break

    widths[widest]!--
  }

  return widths
}

// A table with its cells wrapped inside their column, a rule under the header row.
function renderTable(rows: string[][], aligns: Align[], width: number, theme: Theme): string {
  const widths = columnWidths(rows, width)

  const wrapped = rows.map(row => widths.map((each, column) => Bun.wrapAnsi(row[column] ?? '', each, { hard: true }).split('\n')))
  // A blank line between the rows once any of them wraps, so each stays one block; a table whose rows all fit on a line stays compact.
  const spaced = wrapped.some(cells => cells.some(cell => cell.length > 1))

  const lines = rows.flatMap((_, index) => {
    const cells = wrapped[index]!
    const height = Math.max(...cells.map(cell => cell.length))

    const drawn = Array.from({ length: height }, (_, at) => cells.map((cell, column) => {
      const text = cell[at] ?? ''
      const gap = ' '.repeat(Math.max(0, (widths[column] ?? 0) - textWidth(text)))
      const aligned = aligns[column] === 'right' ? `${gap}${text}` : `${text}${gap}`

      return index === 0 ? theme.heading(aligned) : aligned
    }).join(' '.repeat(COLUMN_GAP)).trimEnd())

    if (index === 0)
      return [...drawn, theme.dim('─'.repeat(Math.min(width, widths.reduce((sum, each) => sum + each, 0) + COLUMN_GAP * Math.max(0, widths.length - 1))))]

    return spaced && index > 1 ? ['', ...drawn] : drawn
  })

  return lines.join('\n')
}

// The text without terminal escapes or control characters that would draw on the terminal or collide with the markers above; tabs and line breaks stay.
function printable(source: string): string {
  return Array.from(stripAnsi(source.replaceAll('\r\n', '\n'))).filter(char => char >= ' ' || char === '\n' || char === '\t').join('')
}

export function renderMarkdown(source: string, { theme, width }: RenderSettings): string {
  const quote = [`${theme.shade('❝', 0)} `, '  ']
  let aligns: Align[] = []

  const rendered = Bun.markdown.render(printable(source), {
    heading: (children, { level }) => block(`${reflow(theme.shade(theme.bold(children), HEADING_SHADES[Math.min(level, HEADING_SHADES.length) - 1] ?? 1), theme.dim(`${'#'.repeat(level)} `), ' '.repeat(level + 1))}\n\n`),
    paragraph: children => block(`${reflow(children.replaceAll('\n', ' '))}\n\n`),
    strong: text => theme.shade(theme.bold(text), 0),
    emphasis: theme.italic,
    strikethrough: theme.strike,
    codespan: text => `${theme.dim('`')}${theme.accent(text)}${theme.dim('`')}`,
    link: (children, { href }) => theme.link(children, href),
    image: (children, { src }) => theme.dim(`[image: ${children === '' ? src : children}]`),
    html: children => block(`${theme.dim(trimmed(children))}\n\n`),
    code: (children, meta) => {
      const language = languageOf(meta?.language ?? '')
      const body = trimmed(children)
      const lines = (language === undefined ? body : highlight(body, language, theme)).split('\n')
      const rule = Math.min(width, MAX_CODE_RULE, Math.max(MIN_CODE_RULE, ...lines.map(line => textWidth(line))))
      const label = meta?.language === undefined || meta.language === '' ? '' : `${meta.language} `

      return block(`${theme.dim(`${label}${'─'.repeat(Math.max(0, rule - textWidth(label)))}`)}\n${lines.join('\n')}\n${theme.dim('─'.repeat(rule))}\n\n`)
    },
    blockquote: children => block(`${indent(trimmed(children.replaceAll(BLOCK, '')), quote[0]!, quote[1]!)}\n\n`),
    hr: () => block(`${theme.dim('─'.repeat(Math.min(width, MAX_RULE)))}\n\n`),
    list: (children, { depth }) => depth > 0 ? `${NESTED}${trimmed(children)}\n\n` : block(`${trimmed(children)}\n\n`),
    listItem: (children, { index, ordered, start, checked }) => {
      const [head = '', ...nested] = children.split(NESTED)
      const blocksAt = head.indexOf(BLOCK)
      const inline = (blocksAt === -1 ? head : head.slice(0, blocksAt)).trim()
      const blocks = blocksAt === -1 ? '' : trimmed(head.slice(blocksAt).replaceAll(BLOCK, ''))
      const text = [inline === '' ? '' : reflow(inline.replaceAll('\n', ' ')), blocks].filter(part => part !== '').join('\n') || reflow('')
      let marker = theme.dim('-')

      if (checked !== undefined)
        marker = checked ? theme.added('✓') : theme.dim('○')
      else if (ordered)
        marker = theme.dim(`${(start ?? 1) + index}.`)

      return `${indent([text, ...nested.map(trimmed)].join('\n'), `${marker} `, ' '.repeat(textWidth(marker) + 1))}\n`
    },
    th: (children, meta) => {
      aligns.push(meta?.align === 'right' ? 'right' : 'left')

      return `${children}${CELL}`
    },
    td: children => `${children}${CELL}`,
    tr: children => `${children}${ROW}`,
    table: (children) => {
      const rows = children.split(ROW).filter(row => row !== '').map(row => row.split(CELL).slice(0, -1))
      const drawn = renderTable(rows, aligns, width, theme)

      aligns = []

      return block(`${drawn}\n\n`)
    },
  })

  return `${finish(trimmed(rendered.replaceAll(BLOCK, '')), width)}\n`
}
