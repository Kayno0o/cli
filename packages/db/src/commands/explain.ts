import type { Dialect } from '../guard'
import { fail, jsonOption, parse } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE, statementTimeout } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'
import { readSql } from './query'

const usage = `db explain "<sql>" [--analyze]

Prints the plan the engine would run for one read (the SQL as an argument, or on stdin) without running it.
The statement must start with SELECT, WITH, VALUES or TABLE and passes the query's read-only guard, so a hand-written EXPLAIN or ANALYZE is refused. --analyze runs the read to time it, inside the rolled-back READ ONLY transaction (refused on a MySQL before 8.0.18).

${HOSTS_NOTE}`

const options = { ...connectionOptions, json: jsonOption(), analyze: { type: 'boolean', description: 'run the read to time it, in the transaction that is rolled back' } } as const
const READ_START = /^\s*(?:select|with|values|table)\b/i
const TRAILING_SEMICOLON = /;\s*$/
const MARIADB = /mariadb/i
const MYSQL_VERSION = /^(\d+)\.(\d+)\.(\d+)/

// The EXPLAIN of a plain read, refused when the guard sees anything but one read.
export function explainSql(sql: string, dialect: Dialect, prefix = 'EXPLAIN'): string {
  const verdict = inspect(sql, dialect)

  if (!READ_START.test(sql) || verdict.reasons.length > 0 || verdict.statements > 1)
    fail(`not a plain read to explain: ${verdict.reasons.join('; ') || 'start with SELECT, WITH, VALUES or TABLE, one statement at a time'}`)

  return `${prefix} ${sql.trim().replace(TRAILING_SEMICOLON, '')}`
}

// What runs a statement and times it on this server: MariaDB's ANALYZE, MySQL's EXPLAIN ANALYZE from 8.0.18, refused before.
export function analyzePrefix(version: string): string {
  if (MARIADB.test(version))
    return 'ANALYZE'

  const [, major = 0, minor = 0, patch = 0] = MYSQL_VERSION.exec(version)?.map(Number) ?? []

  if (major > 8 || (major === 8 && (minor > 0 || patch >= 18)))
    return 'EXPLAIN ANALYZE'

  return fail(`--analyze needs MySQL 8.0.18 or later or MariaDB, this server is ${version}`)
}

export async function explain(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, { exits: EXITS })
  const sql = await readSql(positionals)
  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const timeout = statementTimeout(values)
  let prefix = 'EXPLAIN'

  if (values.analyze === true)
    prefix = dialect === 'postgres' ? 'EXPLAIN ANALYZE' : analyzePrefix(String((await readRows(url, 'select version() as version', [], undefined, undefined, timeout))[0]?.version))

  const rows = await readRows(url, explainSql(sql, dialect, prefix), [], undefined, undefined, timeout)
  const [only, ...others] = Object.keys(rows[0] ?? {})

  console.log(values.json !== true && only !== undefined && others.length === 0 ? rows.map(row => String(row[only])).join('\n') : render(shape(rows, rows.length, true), values.json === true))

  return 0
}
