import { fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { connectionOptions, DEFAULT_LIMIT, HOSTS_NOTE, outputOptions } from '../args'
import { render, shape } from '../output'
import { connectionUrl, readRows } from '../run'

const options = { ...connectionOptions, ...outputOptions } as const

const EXITS = 'Exits 0 when it listed them, 1 when the database refused or was unreachable, 2 on a usage error or a host that is not allowed.'

const TABLES = `
select n.nspname as schema, c.relname as name,
  case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview' else 'foreign' end as kind,
  c.reltuples::bigint as rows_estimate
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by n.nspname, c.relname`

const DATABASES = `
select datname as name, datname = current_database() as current, pg_size_pretty(pg_database_size(datname)) as size
from pg_database
where not datistemplate and has_database_privilege(datname, 'CONNECT')
order by datname`

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

  const { values, positionals } = parsed
  const { sql, params } = work(positionals)
  const limit = wholeNumber(values.limit, 'limit', DEFAULT_LIMIT, 0)
  const rows = await readRows(await connectionUrl(values), sql, params, limit)

  console.log(render(shape(rows, limit, true, false), values.json === true))

  return 0
}

export async function tables(args: string[]): Promise<number> {
  return show(args, `db tables\n\nLists the tables, views and materialized views outside the system schemas, with an estimated row count.\n\n${HOSTS_NOTE}\n\n${EXITS}`, () => ({ sql: TABLES, params: [] }))
}

export async function databases(args: string[]): Promise<number> {
  return show(args, `db dbs\n\nLists the databases the connection may open, with their size, marking the one it reads, so --database can pick another.\n\n${HOSTS_NOTE}\n\n${EXITS}`, () => ({ sql: DATABASES, params: [] }))
}

export async function describe(args: string[]): Promise<number> {
  return show(args, `db describe <table>\n\nLists a table's columns with type, nullability, default and primary key. Takes \`schema.table\` to tell apart tables of the same name.\n\n${HOSTS_NOTE}\n\n${EXITS}`, ([target, ...extra]) => {
    if (target === undefined || extra.length > 0)
      fail('db describe takes one table name')

    const [first, second] = target.split('.')

    return { sql: COLUMNS, params: second === undefined ? [first, null] : [second, first] }
  })
}
