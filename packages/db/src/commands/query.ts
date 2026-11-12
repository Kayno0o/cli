import { Exit, fail, jsonText, parse, problem, readInput } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE, outputOptions, rowLimit, statementTimeout, WRITE_EXIT, WRITE_NOTE } from '../args'
import { inspect } from '../guard'
import { jsonValue, render, shape } from '../output'
import { connectionUrl, databaseOfUrl, dialectOf, readRows, TEST_SUFFIX, writeRows } from '../run'

const usage = `db query "<sql>"

Runs one read-only statement (the SQL as an argument, or on stdin) in a READ ONLY transaction that is rolled back, on Postgres, MySQL or MariaDB.
Only a single statement starting with SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE or DESC, with no write or side-effect function in it, runs; several statements are refused (exit 2).
Sensitive columns (emails, tokens, passwords...) show *** unless --raw.

${WRITE_NOTE}

${HOSTS_NOTE}`

const options = { ...connectionOptions, ...outputOptions } as const

const NO_SQL = 'no SQL given: pass it as an argument or on stdin'

export async function readSql(positionals: string[]): Promise<string> {
  const sql = positionals.length === 0 ? await readInput('-', { noStdin: NO_SQL }) : positionals.join(' ')

  if (sql.trim() === '')
    fail(NO_SQL)

  return sql
}

function handBack(sql: string, reasons: string[], note = ''): number {
  problem(`db: not run, this statement would write or cannot be shown to only read (${reasons.join('; ')})${note}. Run it yourself:`)
  console.log(`\`\`\`sql\n${sql.trim()}\n\`\`\``)

  return WRITE_EXIT
}

// A write is judged as both engines when the target cannot be resolved, so it is still printed.
function isWrite(sql: string): boolean {
  return inspect(sql, 'postgres').reasons.length > 0 || inspect(sql, 'mysql').reasons.length > 0
}

export async function query(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values, positionals } = parsed
  const limit = rowLimit(values)
  const sql = await readSql(positionals)
  let url: string

  try {
    url = await connectionUrl(values)
  }
  catch (error) {
    if (error instanceof Exit && isWrite(sql))
      return handBack(sql, inspect(sql, 'postgres').reasons.concat(inspect(sql, 'mysql').reasons))

    throw error
  }

  const dialect = dialectOf(new URL(url))
  const verdict = inspect(sql, dialect)

  if (verdict.reasons.length > 0) {
    const written = await writeRows(url, sql)

    if (!written.isRun)
      return handBack(sql, verdict.reasons, databaseOfUrl(url).endsWith(TEST_SUFFIX) ? `; not run on this ${TEST_SUFFIX} database either: ${written.reasons.join('; ')}` : '')

    const shown = shape(written.rows, limit, values.raw === true, false)

    if (values.json === true)
      console.log(jsonText({ database: written.database, affected: written.affected, columns: shown.columns, rows: shown.rows, truncated: shown.truncated, masked: shown.masked }, jsonValue))
    else
      console.log(`ran on ${written.database}, ${written.affected} ${written.affected === 1 ? 'row' : 'rows'} affected${written.rows.length === 0 ? '' : `\n${render(shown, false, values.format)}`}`)

    return 0
  }

  if (verdict.statements > 1)
    fail('one statement at a time')

  const rows = await readRows(url, sql, [], limit, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, values.raw === true, false), values.json === true, values.format))

  return 0
}
