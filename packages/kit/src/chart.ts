import process from 'node:process'
import { formatPercent, textWidth } from './format'
import { outputMode } from './mode'
import { paint, takesControlCodes } from './style'
import { activeTheme, tinted } from './theme'

type Env = Record<string, string | undefined>

const LEVELS = '▁▂▃▄▅▆▇█'
// What a bar is drawn with where there is no colour to tell its two parts apart; a theme only changes the bar on a terminal.
const FILLED = '━'
const EMPTY = '─'

// One block per value, tall in proportion to where it sits between the smallest and the largest; a flat series draws mid-height. For an agent, which cannot read the blocks, the values themselves apart by a space.
export function sparkline(values: number[], { stream = process.stdout, env = process.env }: KeyValueSettings = {}): string {
  if (values.length === 0)
    return ''

  if (outputMode(stream, env) === 'agent')
    return values.join(' ')

  const low = Math.min(...values)
  const span = Math.max(...values) - low

  const blocks = values.map(value => LEVELS[span === 0 ? 3 : Math.round((value - low) / span * (LEVELS.length - 1))]).join('')

  return takesControlCodes(stream, env) ? tinted(paint(stream, env), activeTheme().theme.colors.accent, env)(blocks) : blocks
}

export interface BarSettings {
  width?: number
  stream?: { isTTY?: boolean }
  env?: Env
}

// `━━━━━━━━━━━━━━━━━━━━` for a ratio between 0 and 1, the filled part cyan and the rest the same glyph dimmed on a terminal, so the two share one baseline; with no colour the rest is `─`.
export function bar(ratio: number, { width = 20, stream = process.stdout, env = process.env }: BarSettings = {}): string {
  if (outputMode(stream, env) === 'agent')
    return formatPercent(Math.min(1, Math.max(0, ratio)))

  const colors = paint(stream, env)
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)

  if (!takesControlCodes(stream, env))
    return `${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}`

  const { theme } = activeTheme()

  return `${tinted(colors, theme.colors.accent, env)(theme.glyphs.bar.repeat(filled))}${colors.dim(theme.glyphs.bar.repeat(width - filled))}`
}

export interface KeyValueSettings {
  stream?: { isTTY?: boolean }
  env?: Env
}

// Labels dimmed and padded to the longest, one pair per line: `state   open`; for an agent the pair is split by a tab with no padding.
export function keyValue(pairs: [label: string, value: string][], { stream = process.stdout, env = process.env }: KeyValueSettings = {}): string {
  if (outputMode(stream, env) === 'agent')
    return pairs.map(([label, value]) => `${label}\t${value}`).join('\n')

  const colors = paint(stream, env)
  const width = Math.max(0, ...pairs.map(([label]) => textWidth(label)))

  return pairs.map(([label, value]) => `${colors.dim(label)}${' '.repeat(width - textWidth(label))}  ${value}`).join('\n')
}

export interface BarChartSettings extends KeyValueSettings {
  // Columns the bars take, 24 by default.
  width?: number
  // Formats the number at the end of each row.
  format?: (value: number) => string
}

// A bar per labelled value, scaled to the largest: `label  ██████░░░░░░  42`. For an agent, which cannot read the drawing, each value over the largest instead: `label  30/42`. Off a terminal the bars are left out: `label  42`.
export function barChart(rows: [label: string, value: number][], { width = 24, format = String, stream = process.stdout, env = process.env }: BarChartSettings = {}): string {
  const largest = Math.max(0, ...rows.map(([, value]) => value))
  const labels = Math.max(0, ...rows.map(([label]) => textWidth(label)))
  const values = Math.max(0, ...rows.map(([, value]) => textWidth(format(value))))

  if (outputMode(stream, env) === 'agent')
    return rows.map(([label, value]) => `${label}\t${format(value)}/${format(largest)}`).join('\n')

  const drawn = takesControlCodes(stream, env)

  return rows.map(([label, value]) => `${label}${' '.repeat(labels - textWidth(label))}  ${drawn ? `${bar(largest === 0 ? 0 : value / largest, { width, stream, env })}  ` : ''}${' '.repeat(values - textWidth(format(value)))}${format(value)}`).join('\n')
}

export interface TreeNode {
  label: string
  children?: TreeNode[]
}

// The nodes one per line, two spaces deeper per level and no branch drawing, which an agent reads by the indent alone.
function indented(nodes: TreeNode[], indent: string): string {
  return nodes.map(({ label, children = [] }) => [`${indent}${label}`, ...children.length === 0 ? [] : [indented(children, `${indent}  `)]].join('\n')).join('\n')
}

// Each root on a line of its own, bold on a terminal, and its children under it, hung on dimmed `├─`, `└─` and `│` branches, the horizontal stroke the theme's rule glyph.
export function tree(roots: TreeNode[], { stream = process.stdout, env = process.env }: KeyValueSettings = {}): string {
  if (outputMode(stream, env) === 'agent')
    return indented(roots, '')

  const colors = paint(stream, env)
  const stroke = takesControlCodes(stream, env) ? activeTheme().theme.glyphs.rule : '─'
  const lines: string[] = []

  function branch(nodes: TreeNode[], indent: string) {
    for (const [index, { label, children = [] }] of nodes.entries()) {
      const last = index === nodes.length - 1

      lines.push(`${colors.dim(`${indent}${last ? '└' : '├'}${stroke}`)} ${label}`)
      branch(children, `${indent}${last ? '   ' : '│  '}`)
    }
  }

  for (const { label, children = [] } of roots) {
    lines.push(colors.bold(label))
    branch(children, '')
  }

  return lines.join('\n')
}
