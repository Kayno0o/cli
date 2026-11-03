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

const BULLETS = ['•', '◦', '▪']
const MAX_RULE = 60
const MIN_ROOM = 20
const MIN_COLUMN = 8
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

// The columns' widths, the widest narrowed one character at a time until the row fits `width`.
function columnWidths(rows: string[][], width: number): number[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => textWidth(row[column] ?? '')))) ?? []
  const total = () => widths.reduce((sum, each) => sum + each, 0) + COLUMN_GAP * Math.max(0, widths.length - 1)

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

  const lines = rows.flatMap((row, index) => {
    const cells = widths.map((each, column) => Bun.wrapAnsi(row[column] ?? '', each, { hard: true }).split('\n'))
    const height = Math.max(...cells.map(cell => cell.length))

    const drawn = Array.from({ length: height }, (_, at) => cells.map((cell, column) => {
      const text = cell[at] ?? ''
      const gap = ' '.repeat(Math.max(0, (widths[column] ?? 0) - textWidth(text)))
      const aligned = aligns[column] === 'right' ? `${gap}${text}` : `${text}${gap}`

      return index === 0 ? theme.bold(aligned) : aligned
    }).join(' '.repeat(COLUMN_GAP)).trimEnd())

    return index === 0 ? [...drawn, theme.dim('─'.repeat(Math.min(width, widths.reduce((sum, each) => sum + each, 0) + COLUMN_GAP * Math.max(0, widths.length - 1))))] : drawn
  })

  return lines.join('\n')
}

// The text without terminal escapes or control characters that would draw on the terminal or collide with the markers above; tabs and line breaks stay.
function printable(source: string): string {
  return Array.from(stripAnsi(source.replaceAll('\r\n', '\n'))).filter(char => char >= ' ' || char === '\n' || char === '\t').join('')
}

export function renderMarkdown(source: string, { theme, width }: RenderSettings): string {
  const bar = theme.dim('│ ')
  const quote = theme.dim('▎ ')
  let aligns: Align[] = []

  const rendered = Bun.markdown.render(printable(source), {
    heading: (children, { level }) => block(`${reflow(theme.heading(children), theme.dim(`${'#'.repeat(level)} `), ' '.repeat(level + 1))}\n\n`),
    paragraph: children => block(`${reflow(children.replaceAll('\n', ' '))}\n\n`),
    strong: theme.bold,
    emphasis: theme.italic,
    strikethrough: theme.strike,
    codespan: theme.code,
    link: (children, { href }) => theme.link(children, href),
    image: (children, { src }) => theme.dim(`[image: ${children === '' ? src : children}]`),
    html: children => block(`${theme.dim(trimmed(children))}\n\n`),
    code: (children, meta) => {
      const language = languageOf(meta?.language ?? '')
      const body = trimmed(children)

      return block(`${(language === undefined ? body : highlight(body, language, theme)).split('\n').map(line => `${bar}${line}`).join('\n')}\n\n`)
    },
    blockquote: children => block(`${indent(trimmed(children.replaceAll(BLOCK, '')), quote, quote)}\n\n`),
    hr: () => block(`${theme.dim('─'.repeat(Math.min(width, MAX_RULE)))}\n\n`),
    list: (children, { depth }) => depth > 0 ? `${NESTED}${trimmed(children)}\n\n` : block(`${trimmed(children)}\n\n`),
    listItem: (children, { index, ordered, start, depth, checked }) => {
      const [head = '', ...nested] = children.split(NESTED)
      const blocksAt = head.indexOf(BLOCK)
      const inline = (blocksAt === -1 ? head : head.slice(0, blocksAt)).trim()
      const blocks = blocksAt === -1 ? '' : trimmed(head.slice(blocksAt).replaceAll(BLOCK, ''))
      const text = [inline === '' ? '' : reflow(inline.replaceAll('\n', ' ')), blocks].filter(part => part !== '').join('\n') || reflow('')
      let marker = theme.accent(BULLETS[depth % BULLETS.length] ?? '•')

      if (checked !== undefined)
        marker = checked ? theme.added('✓') : theme.dim('○')
      else if (ordered)
        marker = theme.accent(`${(start ?? 1) + index}.`)

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
