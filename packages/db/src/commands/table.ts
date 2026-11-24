import type { Dialect } from '../guard'
import type { Tx } from '../run'
import { fail, parse } from '@kaynooo/cli-kit'
import { connectionOptions, EXITS, HOSTS_NOTE, outputOptions, rowLimit, statementTimeout, unmaskSet } from '../args'
import { inspect } from '../guard'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, fetchRows, withReadSession } from '../run'

const SAMPLE_LIMIT = 5
const NAME = /^[A-Z_][\w$]*(?:\.[A-Z_][\w$]*)?$/i
const ORDER_SPEC = /^([A-Z_][\w$]*)(?:\s+(asc|desc))?$/i
const LATEST_CANDIDATES = ['created_at', 'updated_at', 'inserted_at', 'timestamp', 'createdat', 'updatedat', 'id']

// A table name is a plain identifier, or `schema.table`, quoted for the engine; anything else is refused rather than escaped.
export function quotedTable(target: string, dialect: Dialect): string {
  if (!NAME.test(target))
    fail(`${target} is not a table name: use name or schema.name`)

  const quote = dialect === 'mysql' ? '`' : '"'

  return target.split('.').map(part => `${quote}${part}${quote}`).join('.')
}

function quoteIdent(name: string, dialect: Dialect): string {
  const quote = dialect === 'mysql' ? '`' : '"'

  return `${quote}${name}${quote}`
}

function orderClause(order: string | undefined, dialect: Dialect): string {
  if (order === undefined)
    return ''

  const match = ORDER_SPEC.exec(order.trim())

  if (match === null)
    fail(`--order expects "<column>" or "<column> asc|desc", not ${order}`)

  const col = quoteIdent(match[1]!, dialect)
  const dir = (match[2] ?? 'asc').toUpperCase()

  return ` order by ${col} ${dir}`
}

const whereOf = (where: string | undefined) => where === undefined ? '' : ` where ${where}`

export function sampleSql(target: string, dialect: Dialect, limit: number, where: string | undefined, order?: string): string {
  const limitPart = Number.isFinite(limit) ? ` limit ${limit}` : ''

  return `select * from ${quotedTable(target, dialect)}${whereOf(where)}${orderClause(order, dialect)}${limitPart}`
}

export function countSql(target: string, dialect: Dialect, where: string | undefined): string {
  return `select count(*) as count from ${quotedTable(target, dialect)}${whereOf(where)}`
}

async function detectLatestColumn(tx: Tx, dialect: Dialect, target: string): Promise<string | undefined> {
  const [first, second] = target.split('.')
  const tableName = second ?? first!
  const schema = second === undefined ? undefined : first
  let colNames: string[]

  if (dialect === 'sqlite') {
    const info = await tx.unsafe(`pragma table_info("${tableName.replaceAll('"', '""')}")`)

    colNames = info.map(row => String(row.name ?? ''))
  }
  else if (dialect === 'postgres') {
    const rows = await tx.unsafe('select column_name as name from information_schema.columns where table_name = $1 and ($2::text is null or table_schema = $2) order by ordinal_position', [tableName, schema ?? null])

    colNames = rows.map(row => String(row.name ?? ''))
  }
  else {
    const rows = await tx.unsafe(`select column_name as name from information_schema.columns where table_name = ?${schema === undefined ? ' and table_schema = coalesce(database(), table_schema)' : ' and table_schema = ?'} order by ordinal_position`, schema === undefined ? [tableName] : [tableName, schema])

    colNames = rows.map(row => String(row.name ?? ''))
  }

  const byLower = new Map(colNames.map(name => [name.toLowerCase(), name]))

  for (const candidate of LATEST_CANDIDATES) {
    const found = byLower.get(candidate)

    if (found !== undefined)
      return found
  }

  return undefined
}

const where = { type: 'string', short: 'w', description: 'only the rows matching this SQL condition' } as const
const sampleOptions = {
  ...connectionOptions,
  ...outputOptions,
  where,
  latest: { type: 'boolean', short: 'L', description: 'order newest rows first (auto-detects created_at/updated_at/timestamp/id)', conflicts: ['order'] },
  order: { type: 'string', description: 'sort by "<column>" or "<column> asc|desc"', conflicts: ['latest'] },
} as const
const countOptions = { ...connectionOptions, json: outputOptions.json, format: outputOptions.format, where } as const

export async function sample(args: string[]): Promise<number> {
  const usage = `db sample <table> [-n ${SAMPLE_LIMIT}|--all] [--latest | --order "<col> [asc|desc]"] [--where <sql>]\n\nPrints a few rows of a table (\`schema.table\` to pick a schema, the name is case sensitive on Postgres), sensitive columns masked as in a query.\n\n${HOSTS_NOTE}`
  const { values, positionals } = parse(args, usage, sampleOptions, { exits: EXITS })
  const [target, ...extra] = positionals

  if (target === undefined || extra.length > 0)
    fail('give one table name')

  const url = await connectionUrl(values)
  const limit = rowLimit(values, SAMPLE_LIMIT)
  const unmask = unmaskSet(values.unmask)
  const rows = await withReadSession(url, async (tx, dialect) => {
    let order = values.order

    if (values.latest === true) {
      const col = await detectLatestColumn(tx, dialect, target)

      if (col !== undefined)
        order = `${col} desc`
    }

    const sql = sampleSql(target, dialect, limit, values.where, order)
    const verdict = inspect(sql, dialect)

    if (verdict.reasons.length > 0 || verdict.statements > 1)
      fail(`not a plain read: ${verdict.reasons.join('; ') || 'one statement at a time'}`)

    return [...await fetchRows(tx, dialect, sql, [], limit)]
  }, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, values.raw === true, false, unmask), values.json === true, values.format))

  return 0
}

export async function count(args: string[]): Promise<number> {
  const usage = `db count <table> [--where <sql>]\n\nPrints the number of rows of a table (the name is case sensitive on Postgres), or of those matching a condition.\n\n${HOSTS_NOTE}`
  const { values, positionals } = parse(args, usage, countOptions, { exits: EXITS })
  const [target, ...extra] = positionals

  if (target === undefined || extra.length > 0)
    fail('give one table name')

  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const sql = countSql(target, dialect, values.where)
  const verdict = inspect(sql, dialect)

  if (verdict.reasons.length > 0 || verdict.statements > 1)
    fail(`not a plain read: ${verdict.reasons.join('; ') || 'one statement at a time'}`)

  const rows = await withReadSession(url, async tx => [...await tx.unsafe(sql)], undefined, statementTimeout(values))

  console.log(render(shape(rows, 1, true, true), values.json === true, values.format))

  return 0
}
