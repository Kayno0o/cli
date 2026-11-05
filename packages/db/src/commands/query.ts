import { Exit, fail, jsonText, parse, readInput } from '@kaynooo/cli-kit'
import { connectionOptions, DEFAULT_LIMIT, EXITS, HOSTS_NOTE, outputOptions, rowLimit, WRITE_NOTE } from '../args'
import { inspect } from '../guard'
import { jsonValue, render, shape } from '../output'
import { connectionUrl, databaseOfUrl, dialectOf, readRows, TEST_SUFFIX, writeRows } from '../run'

const usage = `db query "<sql>"

Runs one read-only statement (the SQL as an argument, or on stdin) in a READ ONLY transaction that is rolled back, on Postgres, MySQL or MariaDB. A statement that would write is printed for you to run instead, and exits 1 without running.

The SQL is tokenized the way its engine reads it and refused unless it starts with SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE or DESC and uses no INSERT, UPDATE, DELETE, MERGE, INTO, SET or FOR UPDATE anywhere (a write hidden in a CTE is caught), nor a function with side effects (nextval, setval, set_config, pg_terminate_backend, pg_sleep, dblink, sleep, load_file...). Several statements are refused (exit 2) even when each reads.
Statements time out after 30 seconds and show at most -n rows (${DEFAULT_LIMIT}, --all for 100), a Postgres select being read through a cursor that stops one row past it. Columns named like emails, phones, tokens, secrets, passwords or hashes show *** unless --raw, and every message is scrubbed of the URL and password.

${WRITE_NOTE}

${HOSTS_NOTE}`

const options = { ...connectionOptions, ...outputOptions } as const

export const WRITE_EXIT = 1

const NO_SQL = 'no SQL given: pass it as an argument or on stdin'

export async function readSql(positionals: string[]): Promise<string> {
  const sql = positionals.length === 0 ? await readInput('-', { noStdin: NO_SQL }) : positionals.join(' ')

  if (sql.trim() === '')
    fail(NO_SQL)

  return sql
}

function handBack(sql: string, reasons: string[], note = ''): number {
  console.log(`db: not run, this statement would write or cannot be shown to only read (${reasons.join('; ')})${note}. Run it yourself:\n\n\`\`\`sql\n${sql.trim()}\n\`\`\``)

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
      console.log(`ran on ${written.database}, ${written.affected} ${written.affected === 1 ? 'row' : 'rows'} affected${written.rows.length === 0 ? '' : `\n${render(shown, false)}`}`)

    return 0
  }

  if (verdict.statements > 1)
    fail('one statement at a time')

  const rows = await readRows(url, sql, [], limit)

  console.log(render(shape(rows, limit, values.raw === true, false), values.json === true))

  return 0
}
