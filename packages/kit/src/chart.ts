import process from 'node:process'
import { textWidth } from './format'
import { paint } from './style'

type Env = Record<string, string | undefined>

const LEVELS = '▁▂▃▄▅▆▇█'

// One block per value, tall in proportion to where it sits between the smallest and the largest; a flat series draws mid-height.
export function sparkline(values: number[]): string {
  if (values.length === 0)
    return ''

  const low = Math.min(...values)
  const span = Math.max(...values) - low

  return values.map(value => LEVELS[span === 0 ? 3 : Math.round((value - low) / span * (LEVELS.length - 1))]).join('')
}

export interface BarSettings {
  width?: number
  stream?: { isTTY?: boolean }
  env?: Env
}

// `████████░░░░░░░░░░░░` for a ratio between 0 and 1, filled in cyan and the rest dim on a terminal.
export function bar(ratio: number, { width = 20, stream = process.stdout, env = process.env }: BarSettings = {}): string {
  const colors = paint(stream, env)
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)

  return `${colors.cyan('█'.repeat(filled))}${colors.dim('░'.repeat(width - filled))}`
}

export interface KeyValueSettings {
  stream?: { isTTY?: boolean }
  env?: Env
}

// Labels dimmed and padded to the longest, one pair per line: `state   open`.
export function keyValue(pairs: [label: string, value: string][], { stream = process.stdout, env = process.env }: KeyValueSettings = {}): string {
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

// A bar per labelled value, scaled to the largest: `label  ██████░░░░░░  42`.
export function barChart(rows: [label: string, value: number][], { width = 24, format = String, stream = process.stdout, env = process.env }: BarChartSettings = {}): string {
  const largest = Math.max(0, ...rows.map(([, value]) => value))
  const labels = Math.max(0, ...rows.map(([label]) => textWidth(label)))
  const values = Math.max(0, ...rows.map(([, value]) => textWidth(format(value))))

  return rows.map(([label, value]) => `${label}${' '.repeat(labels - textWidth(label))}  ${bar(largest === 0 ? 0 : value / largest, { width, stream, env })}  ${' '.repeat(values - textWidth(format(value)))}${format(value)}`).join('\n')
}
