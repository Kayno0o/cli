import { fail, parse, readInput, wholeNumber } from '@kaynooo/cli-kit'
import { connectionOptions, DEFAULT_LIMIT, HOSTS_NOTE, outputOptions } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, readRows } from '../run'

const usage = `db query "<sql>"

Runs one read-only statement (the SQL as an argument, or on stdin) in a READ ONLY transaction that is rolled back. A statement that would write is printed for you to run instead, and exits 1 without running.

${HOSTS_NOTE}

Exits 0 when the statement ran, 1 when the database refused it, was unreachable or the statement would write, 2 on a usage error or a host that is not allowed.`

const options = { ...connectionOptions, ...outputOptions } as const

export const WRITE_EXIT = 1

const NO_SQL = 'no SQL given: pass it as an argument or on stdin'

export async function readSql(positionals: string[]): Promise<string> {
  const sql = positionals.length === 0 ? await readInput('-', { noStdin: NO_SQL }) : positionals.join(' ')

  if (sql.trim() === '')
    fail(NO_SQL)

  return sql
}

export async function query(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const limit = wholeNumber(values.limit, 'limit', DEFAULT_LIMIT, 0)
  const sql = await readSql(positionals)
  const verdict = inspect(sql)

  if (verdict.reasons.length > 0) {
    console.log(`db: not run, this statement would write or cannot be shown to only read (${verdict.reasons.join('; ')}). Run it yourself:\n\n\`\`\`sql\n${sql.trim()}\n\`\`\``)

    return WRITE_EXIT
  }

  if (verdict.statements > 1)
    fail('one statement at a time')

  const rows = await readRows(await connectionUrl(values), sql, [], limit)

  console.log(render(shape(rows, limit, values.raw === true, false), values.json === true))

  return 0
}
