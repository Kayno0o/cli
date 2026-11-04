import type { Dialect } from '../guard'
import { fail, jsonOption, parse } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'
import { readSql } from './query'

const usage = `db explain "<sql>"

Prints the plan the engine would run for one read (the SQL as an argument, or on stdin) without running it: EXPLAIN alone, never ANALYZE, which would execute the statement. The statement must start with SELECT, WITH, VALUES or TABLE and passes the same read-only guard as a query; EXPLAIN and ANALYZE written by hand are refused.

${HOSTS_NOTE}`

const options = { ...connectionOptions, json: jsonOption() } as const
const READ_START = /^\s*(?:select|with|values|table)\b/i
const TRAILING_SEMICOLON = /;\s*$/

// The EXPLAIN of a plain read, refused when the guard sees anything but one read.
export function explainSql(sql: string, dialect: Dialect): string {
  const verdict = inspect(sql, dialect)

  if (!READ_START.test(sql) || verdict.reasons.length > 0 || verdict.statements > 1)
    fail(`not a plain read to explain: ${verdict.reasons.join('; ') || 'start with SELECT, WITH, VALUES or TABLE, one statement at a time'}`)

  return `EXPLAIN ${sql.trim().replace(TRAILING_SEMICOLON, '')}`
}

export async function explain(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, { exits: EXITS })
  const sql = await readSql(positionals)
  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const rows = await readRows(url, explainSql(sql, dialect))

  if (dialect === 'postgres' && values.json !== true)
    console.log(rows.map(row => String(row['QUERY PLAN'])).join('\n'))
  else
    console.log(render(shape(rows, rows.length, true), values.json === true))

  return 0
}
