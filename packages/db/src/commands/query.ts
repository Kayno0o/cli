import { Exit, fail, jsonText, parse, problem, readInput } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE, outputOptions, rowLimit, statementTimeout, unmaskSet, WRITE_EXIT, WRITE_NOTE } from '../args'
import { inspect } from '../guard'
import { jsonValue, render, shape } from '../output'
import { connectionUrl, databaseOfUrl, dialectOf, isSqliteTarget, readRows, TEST_SUFFIX, writeRows } from '../run'

const usage = `db query [sqlite-file] "<sql>"

Runs one read-only statement (the SQL as an argument, or on stdin) in a READ ONLY transaction that is rolled back, on Postgres, MySQL, MariaDB or SQLite.
Passing a SQLite file path first (\`db ./app.db "select 1"\`) opens that file directly without needing -f.
Only a single statement starting with SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE, DESC or read-only PRAGMA, with no write or side-effect function in it, runs; several statements are refused (exit 2).
Sensitive columns (emails, tokens, passwords...) show *** unless --raw or --unmask <cols>.

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

  const { values } = parsed
  let { positionals } = parsed
  let file = values.file

  // Support `db ./app.db "select 1"` or `db sqlite://app.db "select 1"` shorthand.
  if (file === undefined && positionals.length >= 2 && isSqliteTarget(positionals[0] ?? '')) {
    file = positionals[0]
    positionals = positionals.slice(1)
  }

  const limit = rowLimit(values)
  const unmask = unmaskSet(values.unmask)
  const sql = await readSql(positionals)
  let url: string

  try {
    url = await connectionUrl({ ...values, file })
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

    const shown = shape(written.rows, limit, values.raw === true, false, unmask)

    if (values.json === true)
      console.log(jsonText({ database: written.database, affected: written.affected, columns: shown.columns, rows: shown.rows, truncated: shown.truncated, masked: shown.masked }, jsonValue))
    else
      console.log(`ran on ${written.database}, ${written.affected} ${written.affected === 1 ? 'row' : 'rows'} affected${written.rows.length === 0 ? '' : `\n${render(shown, false, values.format)}`}`)

    return 0
  }

  if (verdict.statements > 1)
    fail('one statement at a time')

  const rows = await readRows(url, sql, [], limit, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, values.raw === true, false, unmask), values.json === true, values.format))

  return 0
}
