import type { Row } from './run'
import { table } from '@kaynooo/cli-kit'
import { maskRows } from './mask'

export interface Shown {
  columns: string[]
  rows: Row[]
  total: number
  omitted: number
  // False when the rows came through a cursor that stopped at the cap, so total and omitted only count what was fetched.
  exact: boolean
  truncated: boolean
  masked: string[]
}

const CELL_WIDTH = 80

export function cell(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'

  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'invalid date' : value.toISOString()

  if (value instanceof Uint8Array)
    return `<${value.byteLength} bytes>`

  return typeof value === 'object' ? JSON.stringify(value, jsonValue) : String(value)
}

// JSON.stringify cannot do bigint, and bytes are never worth dumping.
export function jsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint')
    return value.toString()

  return value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value
}

// Caps the rows and masks sensitive columns, keeping how many were left out.
export function shape(rows: Row[], limit: number, raw: boolean, exact = true): Shown {
  const { rows: masked, masked: columns } = maskRows(rows.slice(0, limit), raw)

  return { columns: Object.keys(rows[0] ?? {}), rows: masked, total: rows.length, omitted: Math.max(0, rows.length - limit), exact, truncated: rows.length > limit, masked: columns }
}

export function render(shown: Shown, json: boolean): string {
  if (json)
    return JSON.stringify({ columns: shown.columns, rows: shown.rows, ...(shown.exact ? { total: shown.total, omitted: shown.omitted } : {}), truncated: shown.truncated, masked: shown.masked }, jsonValue, 2)

  if (shown.total === 0)
    return 'no rows'

  const lines = [table([
    shown.columns,
    ...shown.rows.map(row => shown.columns.map(column => cell(row[column]))),
  ], { cellWidth: CELL_WIDTH })]

  if (shown.truncated && !shown.exact)
    lines.push('... more rows not shown (-n raises the cap)')
  else if (shown.truncated)
    lines.push(`... ${shown.omitted} more ${shown.omitted === 1 ? 'row' : 'rows'} not shown (${shown.total} in all, -n raises the cap)`)

  if (shown.masked.length > 0)
    lines.push(`masked: ${shown.masked.join(', ')} (--raw shows them)`)

  return lines.join('\n')
}
