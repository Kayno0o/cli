import process from 'node:process'
import { truncate as cut } from '@kaynooo/utils'
import { outputMode } from './mode'
import { paint, takesControlCodes } from './style'

export { formatFileSize, formatUnit } from '@kaynooo/utils/format'

const UNITS = [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]] as const

// Renders as "13m 28s": the largest unit and the next one, dropped when zero.
export function formatSeconds(total: number): string {
  let rest = Math.max(0, Math.round(total))
  const amounts = UNITS.map(([unit, size]) => {
    const amount = Math.floor(rest / size)

    rest -= amount * size

    return `${amount}${unit}`
  })
  const first = amounts.findIndex(amount => !amount.startsWith('0'))

  if (first === -1)
    return '0s'

  const next = amounts[first + 1]

  return next === undefined || next.startsWith('0') ? amounts[first] ?? '0s' : `${amounts[first]} ${next}`
}

// Like formatSeconds from a duration in milliseconds, but under a minute with one decimal so a fast step reads `0.3s`, not `0s`.
export function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatSeconds(ms / 1000)
}

// Whole seconds counted like a clock, for a counter redrawn while it runs: tenths would change on every frame.
export function formatElapsed(ms: number): string {
  return formatSeconds(Math.floor(Math.max(0, ms) / 1000))
}

// The text up to the first separator, or all of it.
export function upTo(text: string, separator: string): string {
  const end = text.indexOf(separator)

  return end === -1 ? text : text.slice(0, end)
}

export function formatAge(date: string | number, now = Date.now()): string {
  const at = typeof date === 'number' ? date : Date.parse(date)

  if (Number.isNaN(at))
    return '-'

  const seconds = (now - at) / 1000

  return seconds < 60 ? 'just now' : `${upTo(formatSeconds(seconds), ' ')} ago`
}

export function truncate(text: string, width: number): string {
  return cut(text, width, { suffix: '…', includeSuffix: true })
}

const LINE_BREAKS = /\s*\n\s*/g
const ESCAPE = String.fromCharCode(27)

export type Align = 'left' | 'right'

export interface TableSettings {
  // Flattens each cell's line breaks to a space and cuts it to this many characters.
  cellWidth?: number
  // Takes the first row for column names, bold on a terminal.
  header?: boolean
  // Per column, `right` for numbers; a column not named is left-aligned.
  align?: Align[]
  // Narrows the widest column until a row fits this many characters, `process.stdout.columns` for the terminal's own width. Cells holding colours are never cut.
  fit?: number
  // The stream the header's bold and rule are drawn for, `process.stdout` by default.
  stream?: { isTTY?: boolean }
  env?: Record<string, string | undefined>
}

// Columns in the visible width of a cell, escapes and wide characters accounted for.
export function textWidth(text: string): number {
  return Bun.stringWidth(text)
}

// Rows of cells aligned in columns; for an agent, one row per line with the cells apart by a tab and no padding, rule or colour, since the spaces that line columns up are tokens it pays for and reads no better.
export function table(rows: string[][], { cellWidth, header = false, align = [], fit, stream = process.stdout, env = process.env }: TableSettings = {}): string {
  const cells = cellWidth === undefined ? rows : rows.map(row => row.map(cell => truncate(cell.replaceAll(LINE_BREAKS, ' '), cellWidth)))

  if (outputMode(stream, env) === 'agent')
    return cells.map(row => row.map(cell => Bun.stripANSI(cell).replaceAll(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')

  const widths: number[] = []

  for (const row of cells) {
    for (const [index, cell] of row.entries())
      widths[index] = Math.max(widths[index] ?? 0, textWidth(cell))
  }

  const shown = fit === undefined ? cells : narrow(cells, widths, fit)
  const colors = paint(stream)
  const lines = shown.map(row => row.map((cell, index) => {
    const width = widths[index] ?? 0
    const gap = ' '.repeat(Math.max(0, width - textWidth(cell)))

    if (align[index] === 'right')
      return `${gap}${cell}`

    return index === row.length - 1 ? cell : `${cell}${gap}`
  }).join('  ').trimEnd())

  const rule = header && takesControlCodes(stream) && lines.length > 1 ? [colors.dim('─'.repeat(Math.max(...lines.map(textWidth))))] : []

  return lines.flatMap((line, index) => header && index === 0 ? [colors.bold(line), ...rule] : [line]).join('\n')
}

// The rows with the widest cuttable column cut so every line fits `limit`, `widths` shrinking with it.
function narrow(rows: string[][], widths: number[], limit: number): string[][] {
  const used = () => widths.reduce((sum, width) => sum + width, 0) + 2 * Math.max(0, widths.length - 1)
  const cuttable = (index: number) => rows.every(row => !(row[index] ?? '').includes(ESCAPE))
  const floor = 8

  while (used() > limit) {
    let widest = -1

    for (const [index, width] of widths.entries()) {
      if (cuttable(index) && width > floor && width > (widths[widest] ?? 0))
        widest = index
    }

    if (widest === -1)
      break

    widths[widest] = Math.max(floor, (widths[widest] ?? 0) - (used() - limit))
  }

  return rows.map(row => row.map((cell, index) => textWidth(cell) > (widths[index] ?? 0) ? truncate(cell, widths[index] ?? 0) : cell))
}

// The JSON of `value`: indented by two spaces for a person or a log, on one line for an agent, which pays for every indent.
export function jsonText(value: unknown, replacer?: (key: string, value: unknown) => unknown, { stream = process.stdout, env = process.env }: Pick<TableSettings, 'stream' | 'env'> = {}): string {
  return JSON.stringify(value, replacer, outputMode(stream, env) === 'agent' ? undefined : 2)
}

// What a `--json` flag prints, through `jsonText`, on stdout.
export function printJson(value: unknown): void {
  console.log(jsonText(value))
}

// `0.62` as `62%`.
export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

// A change with its sign: `+3`, `-3`, `0`.
export function formatDelta(value: number, digits = 0): string {
  const text = value.toFixed(digits)

  if (Number(text) === 0)
    return text.replace('-', '')

  return value > 0 ? `+${text}` : text
}

export interface ChangeSettings {
  // Which way is an improvement; the other way is painted red.
  better?: 'lower' | 'higher'
  stream?: { isTTY?: boolean }
  env?: Record<string, string | undefined>
}

// How `after` moved from `before` as a signed percentage (`-36%`), green when it improved and red when it did not; `-` when `before` is zero.
export function formatChange(before: number, after: number, { better = 'lower', stream = process.stdout, env = process.env }: ChangeSettings = {}): string {
  if (before === 0)
    return '-'

  const change = (after - before) / before
  const text = `${formatDelta(change * 100)}%`
  const colors = paint(stream, env)

  if (change === 0)
    return colors.dim(text)

  return (change < 0) === (better === 'lower') ? colors.green(text) : colors.red(text)
}
