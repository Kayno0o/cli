import type { Dialect } from '../guard'
import { fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { connectionOptions, HOSTS_NOTE, outputOptions } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'

const SAMPLE_LIMIT = 5
const NAME = /^[A-Z_][\w$]*(?:\.[A-Z_][\w$]*)?$/i

const EXITS = 'Exits 0 when it ran, 1 when the database refused or was unreachable, 2 on a usage error or a host that is not allowed.'

// A table name is a plain identifier, or `schema.table`, quoted for the engine; anything else is refused rather than escaped.
export function quotedTable(target: string, dialect: Dialect): string {
  if (!NAME.test(target))
    fail(`${target} is not a table name: use name or schema.name`)

  const quote = dialect === 'mysql' ? '`' : '"'

  return target.split('.').map(part => `${quote}${part}${quote}`).join('.')
}

const whereOf = (where: string | undefined) => where === undefined ? '' : ` where ${where}`

export function sampleSql(target: string, dialect: Dialect, limit: number, where: string | undefined): string {
  return `select * from ${quotedTable(target, dialect)}${whereOf(where)} limit ${limit}`
}

export function countSql(target: string, dialect: Dialect, where: string | undefined): string {
  return `select count(*) as count from ${quotedTable(target, dialect)}${whereOf(where)}`
}

const where = { type: 'string', short: 'w', description: 'only the rows matching this SQL condition' } as const
const sampleOptions = { ...connectionOptions, ...outputOptions, where } as const
const countOptions = { ...connectionOptions, json: outputOptions.json, where } as const

async function run(args: string[], usage: string, options: typeof sampleOptions | typeof countOptions, build: (target: string, dialect: Dialect, values: { limit: number, where: string | undefined }) => string): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const [target, ...extra] = positionals

  if (target === undefined || extra.length > 0)
    fail('give one table name')

  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const limit = wholeNumber('limit' in values ? values.limit : undefined, 'limit', SAMPLE_LIMIT, 0)
  const sql = build(target, dialect, { limit, where: values.where })
  const verdict = inspect(sql, dialect)

  if (verdict.reasons.length > 0 || verdict.statements > 1)
    fail(`not a plain read: ${verdict.reasons.join('; ') || 'one statement at a time'}`)

  console.log(render(shape(await readRows(url, sql, [], limit), limit, 'raw' in values && values.raw === true, false), values.json === true))

  return 0
}

export async function sample(args: string[]): Promise<number> {
  return run(args, `db sample <table> [-n ${SAMPLE_LIMIT}] [--where <sql>]\n\nPrints a few rows of a table (\`schema.table\` to pick a schema, the name is case sensitive on Postgres), sensitive columns masked as in a query.\n\n${HOSTS_NOTE}\n\n${EXITS}`, sampleOptions, (target, dialect, { limit, where }) => sampleSql(target, dialect, limit, where))
}

export async function count(args: string[]): Promise<number> {
  return run(args, `db count <table> [--where <sql>]\n\nPrints the number of rows of a table (the name is case sensitive on Postgres), or of those matching a condition.\n\n${HOSTS_NOTE}\n\n${EXITS}`, countOptions, (target, dialect, { where }) => countSql(target, dialect, where))
}
