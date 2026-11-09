import type { Dialect } from '../guard'
import type { Format } from '../output'
import { fail, parse } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE, outputOptions, rowLimit, statementTimeout } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'

const SAMPLE_LIMIT = 5
const NAME = /^[A-Z_][\w$]*(?:\.[A-Z_][\w$]*)?$/i

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
const countOptions = { ...connectionOptions, json: outputOptions.json, format: outputOptions.format, where } as const

async function run(args: string[], usage: string, options: typeof sampleOptions | typeof countOptions, build: (target: string, dialect: Dialect, values: { limit: number, where: string | undefined }) => string): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values, positionals } = parsed
  const [target, ...extra] = positionals

  if (target === undefined || extra.length > 0)
    fail('give one table name')

  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const limit = rowLimit(values as { rows?: string, all?: boolean }, SAMPLE_LIMIT)
  const sql = build(target, dialect, { limit, where: values.where })
  const verdict = inspect(sql, dialect)

  if (verdict.reasons.length > 0 || verdict.statements > 1)
    fail(`not a plain read: ${verdict.reasons.join('; ') || 'one statement at a time'}`)

  console.log(render(shape(await readRows(url, sql, [], limit, undefined, statementTimeout(values)), limit, (values as { raw?: boolean }).raw === true, false), values.json === true, (values as { format?: Format }).format))

  return 0
}

export async function sample(args: string[]): Promise<number> {
  return run(args, `db sample <table> [-n ${SAMPLE_LIMIT}|--all] [--where <sql>]\n\nPrints a few rows of a table (\`schema.table\` to pick a schema, the name is case sensitive on Postgres), sensitive columns masked as in a query.\n\n${HOSTS_NOTE}`, sampleOptions, (target, dialect, { limit, where }) => sampleSql(target, dialect, limit, where))
}

export async function count(args: string[]): Promise<number> {
  return run(args, `db count <table> [--where <sql>]\n\nPrints the number of rows of a table (the name is case sensitive on Postgres), or of those matching a condition.\n\n${HOSTS_NOTE}`, countOptions, (target, dialect, { where }) => countSql(target, dialect, where))
}
