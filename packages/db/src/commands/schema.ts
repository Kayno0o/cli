import type { Dialect } from '../guard'
import { fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { connectionOptions, DEFAULT_LIMIT, HOSTS_NOTE, outputOptions } from '../args'
import { render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'

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

// MySQL has no schemas apart from its databases, so a table is told apart by the database it sits in.
const MYSQL_SYSTEM = '\'mysql\', \'information_schema\', \'performance_schema\', \'sys\''

const MYSQL_TABLES = `
select table_schema as \`schema\`, table_name as name,
  case table_type when 'BASE TABLE' then 'table' when 'VIEW' then 'view' else lower(table_type) end as kind,
  table_rows as rows_estimate
from information_schema.tables
where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})
order by table_schema, table_name`

const MYSQL_DATABASES = `
select s.schema_name as name, s.schema_name = database() as \`current\`, concat(round(coalesce(sum(t.data_length + t.index_length), 0) / 1048576, 1), ' MB') as size
from information_schema.schemata s
left join information_schema.tables t on t.table_schema = s.schema_name
where s.schema_name not in ('information_schema', 'performance_schema', 'sys')
group by s.schema_name
order by s.schema_name`

const MYSQL_COLUMNS = `
select table_schema as \`schema\`, column_name as name, column_type as type, is_nullable as nullable, column_default as default_value, column_key = 'PRI' as primary_key
from information_schema.columns
where table_name = ?`

interface Query { sql: string, params: unknown[] }

// The same question per engine, as their catalogs differ.
type Plans = Record<Dialect, Query>

async function show(args: string[], usage: string, work: (positionals: string[]) => Plans): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const plans = work(positionals)
  const limit = wholeNumber(values.limit, 'limit', DEFAULT_LIMIT, 0)
  const url = await connectionUrl(values)
  const { sql, params } = plans[dialectOf(new URL(url))]
  const rows = await readRows(url, sql, params, limit)

  console.log(render(shape(rows, limit, true, false), values.json === true))

  return 0
}

export async function tables(args: string[]): Promise<number> {
  return show(args, `db tables\n\nLists the tables, views and materialized views outside the system schemas, with an estimated row count.\n\n${HOSTS_NOTE}\n\n${EXITS}`, () => ({ postgres: { sql: TABLES, params: [] }, mysql: { sql: MYSQL_TABLES, params: [] } }))
}

export async function databases(args: string[]): Promise<number> {
  return show(args, `db dbs\n\nLists the databases the connection may open, with their size, marking the one it reads, so --database can pick another.\n\n${HOSTS_NOTE}\n\n${EXITS}`, () => ({ postgres: { sql: DATABASES, params: [] }, mysql: { sql: MYSQL_DATABASES, params: [] } }))
}

export async function describe(args: string[]): Promise<number> {
  return show(args, `db describe <table>\n\nLists a table's columns with type, nullability, default and primary key. Takes \`schema.table\` to tell apart tables of the same name (the database, on MySQL).\n\n${HOSTS_NOTE}\n\n${EXITS}`, ([target, ...extra]) => {
    if (target === undefined || extra.length > 0)
      fail('db describe takes one table name')

    const [first, second] = target.split('.')
    const table = second ?? first
    const mysqlScope = second === undefined ? ` and table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})` : ' and table_schema = ?'

    return {
      postgres: { sql: COLUMNS, params: second === undefined ? [first, null] : [second, first] },
      mysql: { sql: `${MYSQL_COLUMNS}${mysqlScope}\norder by table_schema, ordinal_position`, params: second === undefined ? [table] : [table, first] },
    }
  })
}
