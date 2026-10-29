import { fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { connectionOptions, DEFAULT_ENV, DEFAULT_LIMIT, outputOptions } from '../args'
import { render, shape } from '../output'
import { connectionUrl, readRows } from '../run'

const options = { ...connectionOptions, ...outputOptions } as const

const TABLES = `
select n.nspname as schema, c.relname as name,
  case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview' else 'foreign' end as kind,
  c.reltuples::bigint as rows_estimate
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by n.nspname, c.relname`

const COLUMNS = `
select c.table_schema as schema, c.column_name as name, c.data_type as type, c.is_nullable as nullable, c.column_default as default_value,
  exists (
    select 1 from information_schema.table_constraints t
    join information_schema.key_column_usage k on k.constraint_name = t.constraint_name and k.constraint_schema = t.constraint_schema
    where t.constraint_type = 'PRIMARY KEY' and k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = c.column_name
  ) as primary_key
from information_schema.columns c
where c.table_name = $1 and ($2::text is null or c.table_schema = $2)
  and c.table_schema not in ('pg_catalog', 'information_schema')
order by c.table_schema, c.ordinal_position`

async function show(args: string[], usage: string, work: (positionals: string[]) => { sql: string, params: unknown[] }): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const { sql, params } = work(positionals)
  const rows = await readRows(connectionUrl(values.env ?? DEFAULT_ENV), sql, params)

  console.log(render(shape(rows, wholeNumber(values.limit, 'limit', DEFAULT_LIMIT, 0), true), values.json === true))

  return 0
}

export async function tables(args: string[]): Promise<number> {
  return show(args, 'db tables\n\nLists the tables, views and materialized views outside the system schemas, with an estimated row count.', () => ({ sql: TABLES, params: [] }))
}

export async function describe(args: string[]): Promise<number> {
  return show(args, 'db describe <table>\n\nLists a table\'s columns with type, nullability, default and primary key. Takes `schema.table` to tell apart tables of the same name.', ([target, ...extra]) => {
    if (target === undefined || extra.length > 0)
      fail('db describe takes one table name')

    const [first, second] = target.split('.')

    return { sql: COLUMNS, params: second === undefined ? [first, null] : [second, first] }
  })
}
