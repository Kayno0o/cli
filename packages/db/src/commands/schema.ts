import type { Dialect } from '../guard'
import { fail, jsonText, parse } from '@kaynooo/cli-kit'
import { catalogOptions, connectionOptions, EXITS, HOSTS_NOTE, rowLimit, statementTimeout } from '../args'
import { jsonValue, render, shape } from '../output'
import { connectionUrl, dialectOf, readRows } from '../run'

const options = { ...connectionOptions, ...catalogOptions } as const

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

const INDEXES = `
select i.relname as name, ix.indisunique as is_unique, ix.indisprimary as primary_key, pg_get_indexdef(ix.indexrelid) as definition
from pg_index ix
join pg_class t on t.oid = ix.indrelid
join pg_class i on i.oid = ix.indexrelid
join pg_namespace n on n.oid = t.relnamespace
where t.relname = $1 and ($2::text is null or n.nspname = $2) and n.nspname not in ('pg_catalog', 'information_schema')
order by n.nspname, i.relname`

const FOREIGN_KEYS = `
select c.conname as name, pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where c.contype = 'f' and t.relname = $1 and ($2::text is null or n.nspname = $2) and n.nspname not in ('pg_catalog', 'information_schema')
order by n.nspname, c.conname`

// A name matches a table or a column of it, in any schema but the system ones.
const SEARCH = `
select table_schema as schema, table_name as "table", null::text as "column", null::text as type
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema') and table_name ilike $1
union all
select table_schema, table_name, column_name, data_type
from information_schema.columns
where table_schema not in ('pg_catalog', 'information_schema') and column_name ilike $1
order by 1, 2, 3`

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

const MYSQL_SEARCH = `
select table_schema as \`schema\`, table_name as \`table\`, null as \`column\`, null as type
from information_schema.tables
where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM}) and lower(table_name) like lower(?)
union all
select table_schema, table_name, column_name, column_type
from information_schema.columns
where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM}) and lower(column_name) like lower(?)
order by 1, 2, 3`

const MYSQL_INDEXES = `
select index_name as name, non_unique = 0 as is_unique, index_name = 'PRIMARY' as primary_key, group_concat(column_name order by seq_in_index) as columns, index_type as type
from information_schema.statistics
where table_name = ?`

const MYSQL_FOREIGN_KEYS = `
select constraint_name as name, group_concat(column_name order by ordinal_position) as columns, concat(referenced_table_schema, '.', referenced_table_name) as references_table, group_concat(referenced_column_name order by ordinal_position) as referenced_columns
from information_schema.key_column_usage
where referenced_table_name is not null and table_name = ?`

const LIKE_SPECIALS = /[\\%_]/g

// The pattern matching a text anywhere in a name, its own % and _ taken literally.
export const containing = (text: string) => `%${text.replace(LIKE_SPECIALS, '\\$&')}%`

interface Query { sql: string, params: unknown[] }

// The same question per engine, as their catalogs differ.
type Plans = Record<Dialect, Query>

async function show(args: string[], usage: string, work: (positionals: string[]) => Plans): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values, positionals } = parsed
  const plans = work(positionals)
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const { sql, params } = plans[dialectOf(new URL(url))]
  const rows = await readRows(url, sql, params, limit, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, true, false), values.json === true, values.format))

  return 0
}

export async function tables(args: string[]): Promise<number> {
  return show(args, `db tables\n\nLists the tables, views and materialized views outside the system schemas, with an estimated row count.\n\n${HOSTS_NOTE}`, () => ({ postgres: { sql: TABLES, params: [] }, mysql: { sql: MYSQL_TABLES, params: [] } }))
}

export async function databases(args: string[]): Promise<number> {
  return show(args, `db dbs\n\nLists the databases the connection may open, with their size, marking the one it reads, so --database can pick another.\n\n${HOSTS_NOTE}`, () => ({ postgres: { sql: DATABASES, params: [] }, mysql: { sql: MYSQL_DATABASES, params: [] } }))
}

export async function search(args: string[]): Promise<number> {
  return show(args, `db search <text>\n\nFinds the tables and columns whose name contains the text, case insensitive, outside the system schemas (a table match has no column). Use it to locate where a field lives before describing a table.\n\n${HOSTS_NOTE}`, ([text, ...extra]) => {
    if (text === undefined || extra.length > 0)
      fail('db search takes one text')

    const pattern = containing(text)

    return { postgres: { sql: SEARCH, params: [pattern] }, mysql: { sql: MYSQL_SEARCH, params: [pattern, pattern] } }
  })
}

// Where a table is looked up: `name` in any schema, `schema.name` (the database on MySQL) in one.
function tableScope(target: string | undefined, extra: string[]): { table: string, schema: string | undefined } {
  if (target === undefined || extra.length > 0)
    fail('db describe takes one table name')

  const [first, second] = target.split('.')

  return second === undefined ? { table: target, schema: undefined } : { table: second, schema: first }
}

const MYSQL_ANY_SCHEMA = ` and table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})`

// The columns, indexes and foreign keys of a table, one question each per engine.
export function describePlans(table: string, schema: string | undefined): { columns: Plans, indexes: Plans, foreignKeys: Plans } {
  const scope = schema === undefined ? MYSQL_ANY_SCHEMA : ' and table_schema = ?'
  const mysqlParams = schema === undefined ? [table] : [table, schema]
  const postgresParams = [table, schema ?? null]

  return {
    columns: { postgres: { sql: COLUMNS, params: postgresParams }, mysql: { sql: `${MYSQL_COLUMNS}${scope}\norder by table_schema, ordinal_position`, params: mysqlParams } },
    indexes: { postgres: { sql: INDEXES, params: postgresParams }, mysql: { sql: `${MYSQL_INDEXES}${scope}\ngroup by table_schema, index_name, non_unique, index_type\norder by table_schema, index_name`, params: mysqlParams } },
    foreignKeys: { postgres: { sql: FOREIGN_KEYS, params: postgresParams }, mysql: { sql: `${MYSQL_FOREIGN_KEYS}${scope}\ngroup by table_schema, constraint_name, referenced_table_schema, referenced_table_name\norder by table_schema, constraint_name`, params: mysqlParams } },
  }
}

export async function describe(args: string[]): Promise<number> {
  const usage = `db describe <table>\n\nLists a table's columns with type, nullability, default and primary key, then its indexes and foreign keys. Takes \`schema.table\` to tell apart tables of the same name (the database, on MySQL).\n\n${HOSTS_NOTE}`
  const { values, positionals: [target, ...extra] } = parse(args, usage, options, { exits: EXITS })
  const { table, schema } = tableScope(target, extra)
  const plans = describePlans(table, schema)
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const dialect = dialectOf(new URL(url))
  const ask = async (plan: Plans, cap?: number) => readRows(url, plan[dialect].sql, plan[dialect].params, cap, undefined, statementTimeout(values))
  const columns = shape(await ask(plans.columns, limit), limit, true, false)
  const indexes = await ask(plans.indexes)
  const foreignKeys = await ask(plans.foreignKeys)

  if (values.json === true)
    console.log(jsonText({ columns: columns.columns, rows: columns.rows, truncated: columns.truncated, masked: columns.masked, indexes, foreignKeys }, jsonValue))
  else
    console.log(`${render(columns, false, values.format)}\n\nindexes\n${render(shape(indexes, indexes.length, true), false, values.format)}\n\nforeign keys\n${render(shape(foreignKeys, foreignKeys.length, true), false, values.format)}`)

  return 0
}
