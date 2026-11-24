import type { Dialect } from '../guard'
import type { Row, Tx } from '../run'
import { statSync } from 'node:fs'
import process from 'node:process'
import { fail, formatSize, jsonOption, jsonText, paint, parse, role, table } from '@kaynooo/cli-kit'
import { catalogOptions, connectionOptions, EXITS, HOSTS_NOTE, rowLimit, statementTimeout } from '../args'
import { jsonValue, render, shape } from '../output'
import { connectionUrl, isSqliteTarget, sqliteFilePath, withReadSession } from '../run'

const MYSQL_SYSTEM = '\'mysql\', \'information_schema\', \'performance_schema\', \'sys\''
const MIGRATION_TABLES = [
  'doctrine_migration_versions',
  '_prisma_migrations',
  '__drizzle_migrations',
  'knex_migrations',
  'typeorm_migrations',
  'schema_migrations',
  'migrations',
  'alembic_version',
  'flyway_schema_history',
  'goose_db_version',
]

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  defaultValue: string | null
}

export interface SchemaForeignKey {
  column: string
  referencesTable: string
  referencedColumn: string
}

export interface SchemaTable {
  schema: string
  name: string
  kind: string
  columns: SchemaColumn[]
  foreignKeys: SchemaForeignKey[]
}

const quoteSqlite = (name: string) => `"${name.replaceAll('"', '""')}"`

// Reads the full schema (tables, columns, PKs, FKs) in one connection across Postgres, MySQL, and SQLite.
export async function readSchema(url: string, timeoutMs?: number): Promise<SchemaTable[]> {
  return withReadSession(url, async (tx, dialect) => {
    if (dialect === 'sqlite')
      return readSqliteSchema(tx)

    return dialect === 'postgres' ? readPostgresSchema(tx) : readMysqlSchema(tx)
  }, undefined, timeoutMs)
}

async function readSqliteSchema(tx: Tx): Promise<SchemaTable[]> {
  const list = await tx.unsafe(`select name, type as kind from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name`)
  const result: SchemaTable[] = []

  for (const row of list) {
    const name = String(row.name ?? '')
    const quoted = quoteSqlite(name)
    const rawCols = await tx.unsafe(`pragma table_info(${quoted})`)
    const rawFks = await tx.unsafe(`pragma foreign_key_list(${quoted})`)

    result.push({
      schema: 'main',
      name,
      kind: String(row.kind ?? 'table'),
      columns: rawCols.map(col => ({
        name: String(col.name ?? ''),
        type: String(col.type ?? '') || 'ANY',
        nullable: Number(col.notnull) === 0,
        primaryKey: Number(col.pk) > 0,
        defaultValue: col.dflt_value === null || col.dflt_value === undefined ? null : String(col.dflt_value),
      })),
      foreignKeys: rawFks.map(fk => ({
        column: String(fk.from ?? ''),
        referencesTable: String(fk.table ?? ''),
        referencedColumn: String(fk.to ?? ''),
      })),
    })
  }

  return result
}

async function readPostgresSchema(tx: Tx): Promise<SchemaTable[]> {
  const tableRows = await tx.unsafe(`
    select n.nspname as schema, c.relname as name,
      case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview' else 'foreign' end as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    order by n.nspname, c.relname`)
  const colRows = await tx.unsafe(`
    select c.table_schema as schema, c.table_name as table_name, c.column_name as name, c.data_type as type, c.is_nullable as nullable, c.column_default as default_value,
      exists (
        select 1 from information_schema.table_constraints t
        join information_schema.key_column_usage k on k.constraint_name = t.constraint_name and k.constraint_schema = t.constraint_schema
        where t.constraint_type = 'PRIMARY KEY' and k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = c.column_name
      ) as primary_key
    from information_schema.columns c
    where c.table_schema not in ('pg_catalog', 'information_schema')
    order by c.table_schema, c.table_name, c.ordinal_position`)
  const fkRows = await tx.unsafe(`
    select kcu.table_schema as schema, kcu.table_name as table_name, kcu.column_name as col, ccu.table_name as ref_table, ccu.column_name as ref_col
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema not in ('pg_catalog', 'information_schema')`)

  return assembleSchema(tableRows, colRows, fkRows)
}

async function readMysqlSchema(tx: Tx): Promise<SchemaTable[]> {
  const tableRows = await tx.unsafe(`
    select table_schema as \`schema\`, table_name as name,
      case table_type when 'BASE TABLE' then 'table' when 'VIEW' then 'view' else lower(table_type) end as kind
    from information_schema.tables
    where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})
    order by table_schema, table_name`)
  const colRows = await tx.unsafe(`
    select table_schema as \`schema\`, table_name, column_name as name, column_type as type, is_nullable as nullable, column_default as default_value, column_key = 'PRI' as primary_key
    from information_schema.columns
    where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})
    order by table_schema, table_name, ordinal_position`)
  const fkRows = await tx.unsafe(`
    select table_schema as \`schema\`, table_name, column_name as col, referenced_table_name as ref_table, referenced_column_name as ref_col
    from information_schema.key_column_usage
    where referenced_table_name is not null and table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})`)

  return assembleSchema(tableRows, colRows, fkRows)
}

function assembleSchema(tableRows: Row[], colRows: Row[], fkRows: Row[]): SchemaTable[] {
  const byKey = new Map<string, SchemaTable>()

  for (const row of tableRows) {
    const schema = String(row.schema ?? '')
    const name = String(row.name ?? '')
    const entry: SchemaTable = { schema, name, kind: String(row.kind ?? 'table'), columns: [], foreignKeys: [] }

    byKey.set(`${schema}.${name}`, entry)
  }

  for (const col of colRows) {
    const target = byKey.get(`${String(col.schema ?? '')}.${String(col.table_name ?? '')}`)

    if (target === undefined)
      continue

    target.columns.push({
      name: String(col.name ?? ''),
      type: String(col.type ?? ''),
      nullable: String(col.nullable ?? '').toUpperCase() === 'YES',
      primaryKey: col.primary_key === true || Number(col.primary_key) === 1,
      defaultValue: col.default_value === null || col.default_value === undefined ? null : String(col.default_value),
    })
  }

  for (const fk of fkRows) {
    const target = byKey.get(`${String(fk.schema ?? '')}.${String(fk.table_name ?? '')}`)

    if (target === undefined)
      continue

    target.foreignKeys.push({
      column: String(fk.col ?? ''),
      referencesTable: String(fk.ref_table ?? ''),
      referencedColumn: String(fk.ref_col ?? ''),
    })
  }

  return [...byKey.values()]
}

export async function schema(args: string[]): Promise<number> {
  const usage = `db schema [--json]\n\nPrints a compact 1-shot map of every table, its columns, primary keys, and foreign keys in one connection.\n\n${HOSTS_NOTE}`
  const { values } = parse(args, usage, { ...connectionOptions, json: jsonOption('{tables: [{schema, name, kind, columns, foreignKeys}]}') }, { exits: EXITS })
  const url = await connectionUrl(values)
  const tables = await readSchema(url, statementTimeout(values))

  if (values.json === true) {
    console.log(jsonText({ tables }, jsonValue))

    return 0
  }

  if (tables.length === 0) {
    console.log('no tables')

    return 0
  }

  const colors = paint(process.stdout)
  const showSchema = new Set(tables.map(t => t.schema)).size > 1
  const lines = tables.map((entry) => {
    const title = showSchema ? `${entry.schema}.${entry.name}` : entry.name
    const cols = entry.columns.map(col => `${col.name}${col.primaryKey ? ' PK' : ''}:${col.type}${col.nullable ? '?' : ''}`).join(', ')
    const fks = entry.foreignKeys.length === 0 ? '' : `  ${colors.dim(`-> ${entry.foreignKeys.map(fk => `${fk.column}=${fk.referencesTable}.${fk.referencedColumn}`).join(', ')}`)}`

    return `${role('value', process.stdout)(title)} ${colors.dim(entry.kind === 'table' ? '' : `[${entry.kind}] `)}(${cols})${fks}`
  })

  console.log(lines.join('\n'))

  return 0
}

export async function ddl(args: string[]): Promise<number> {
  const usage = `db ddl <table> [--json]\n\nPrints the CREATE TABLE and CREATE INDEX DDL for one table.\n\n${HOSTS_NOTE}`
  const { values, positionals } = parse(args, usage, { ...connectionOptions, json: jsonOption('{table, ddl, indexes}') }, { positionals: ['<table>'], exits: EXITS })
  const [target, ...extra] = positionals

  if (target === undefined || extra.length > 0)
    fail('db ddl takes one table name')

  const [first, second] = target.split('.')
  const tableName = second ?? first!
  const schemaName = second === undefined ? undefined : first
  const url = await connectionUrl(values)

  const result = await withReadSession(url, async (tx, dialect) => {
    if (dialect === 'sqlite') {
      const [main] = await tx.unsafe('select sql from sqlite_master where type in (\'table\', \'view\') and name = ?', [tableName])

      if (main === undefined || typeof main.sql !== 'string')
        fail(`table not found: ${target}`, 1)

      const idxRows = await tx.unsafe('select sql from sqlite_master where type = \'index\' and tbl_name = ? and sql is not null order by name', [tableName])

      return { ddl: `${main.sql};`, indexes: idxRows.map(row => `${String(row.sql)};`) }
    }

    if (dialect === 'mysql') {
      const quoted = schemaName === undefined ? `\`${tableName.replaceAll('`', '``')}\`` : `\`${schemaName.replaceAll('`', '``')}\`.\`${tableName.replaceAll('`', '``')}\``
      const [row] = await tx.unsafe(`show create table ${quoted}`)
      const createSql = String(row?.['Create Table'] ?? row?.['Create View'] ?? '')

      if (createSql === '')
        fail(`table not found: ${target}`, 1)

      return { ddl: `${createSql};`, indexes: [] as string[] }
    }

    // Postgres: synthesize CREATE TABLE from columns + constraints + indexes in one session.
    const cols = await tx.unsafe(`
      select c.column_name as name, c.udt_name as type, c.is_nullable as nullable, c.column_default as default_value
      from information_schema.columns c
      where c.table_name = $1 and ($2::text is null or c.table_schema = $2) and c.table_schema not in ('pg_catalog', 'information_schema')
      order by c.ordinal_position`, [tableName, schemaName ?? null])

    if (cols.length === 0)
      fail(`table not found: ${target}`, 1)

    const constraints = await tx.unsafe(`
      select c.conname as name, pg_get_constraintdef(c.oid) as def
      from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
      where t.relname = $1 and ($2::text is null or n.nspname = $2) and n.nspname not in ('pg_catalog', 'information_schema')
      order by c.contype, c.conname`, [tableName, schemaName ?? null])
    const idxRows = await tx.unsafe(`
      select pg_get_indexdef(ix.indexrelid) as def
      from pg_index ix join pg_class t on t.oid = ix.indrelid join pg_namespace n on n.oid = t.relnamespace
      where t.relname = $1 and not ix.indisprimary and ($2::text is null or n.nspname = $2) and n.nspname not in ('pg_catalog', 'information_schema')`, [tableName, schemaName ?? null])

    const body = [
      ...cols.map(c => `  "${String(c.name)}" ${String(c.type)}${String(c.nullable) === 'NO' ? ' NOT NULL' : ''}${c.default_value === null ? '' : ` DEFAULT ${String(c.default_value)}`}`),
      ...constraints.map(c => `  CONSTRAINT "${String(c.name)}" ${String(c.def)}`),
    ]

    return {
      ddl: `CREATE TABLE ${target} (\n${body.join(',\n')}\n);`,
      indexes: idxRows.map(row => `${String(row.def)};`),
    }
  }, undefined, statementTimeout(values))

  if (values.json === true)
    console.log(jsonText({ table: target, ...result }, jsonValue))
  else
    console.log([result.ddl, ...result.indexes].join('\n'))

  return 0
}

const PG_ACTIVITY = `
select pid, usename as user, state, now() - query_start as duration, wait_event_type as wait_type, left(query, 120) as query
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
order by query_start asc nulls last`

const MYSQL_ACTIVITY = `
select id, user, db, command, time as seconds, state, left(info, 120) as query
from information_schema.processlist
where id <> connection_id()
order by time desc`

const PG_LOCKS = `
select a.pid, a.usename as user, l.mode, l.granted, coalesce(c.relname, l.locktype) as relation, left(a.query, 100) as query
from pg_locks l
join pg_stat_activity a on a.pid = l.pid
left join pg_class c on c.oid = l.relation
where a.pid <> pg_backend_pid()
order by l.granted asc, a.pid`

const MYSQL_LOCKS = `
select trx_id, trx_state, trx_started, trx_mysql_thread_id as thread_id, left(trx_query, 100) as query
from information_schema.innodb_trx
order by trx_started asc`

const PG_SIZES = `
select n.nspname as schema, c.relname as table,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total,
  pg_size_pretty(pg_relation_size(c.oid)) as data,
  pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
  c.reltuples::bigint as rows_estimate
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by pg_total_relation_size(c.oid) desc`

const MYSQL_SIZES = `
select table_schema as \`schema\`, table_name as \`table\`,
  concat(round((data_length + index_length) / 1048576, 2), ' MB') as total,
  concat(round(data_length / 1048576, 2), ' MB') as data,
  concat(round(index_length / 1048576, 2), ' MB') as indexes,
  table_rows as rows_estimate
from information_schema.tables
where table_schema = coalesce(database(), table_schema) and table_schema not in (${MYSQL_SYSTEM})
order by (data_length + index_length) desc`

export async function activity(args: string[]): Promise<number> {
  const usage = `db activity\n\nLists active connections and running queries on Postgres or MySQL.\n\n${HOSTS_NOTE}`
  const { values } = parse(args, usage, { ...connectionOptions, ...catalogOptions }, { exits: EXITS })
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const rows = await withReadSession(url, async (tx, dialect) => {
    if (dialect === 'sqlite')
      fail('db activity is only supported on server databases (Postgres, MySQL/MariaDB)', 2)

    return [...await tx.unsafe(dialect === 'postgres' ? PG_ACTIVITY : MYSQL_ACTIVITY)]
  }, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, true, true), values.json === true, values.format))

  return 0
}

export async function locks(args: string[]): Promise<number> {
  const usage = `db locks\n\nLists active locks and transactions on Postgres or MySQL.\n\n${HOSTS_NOTE}`
  const { values } = parse(args, usage, { ...connectionOptions, ...catalogOptions }, { exits: EXITS })
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const rows = await withReadSession(url, async (tx, dialect) => {
    if (dialect === 'sqlite')
      fail('db locks is only supported on server databases (Postgres, MySQL/MariaDB)', 2)

    return [...await tx.unsafe(dialect === 'postgres' ? PG_LOCKS : MYSQL_LOCKS)]
  }, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, true, true), values.json === true, values.format))

  return 0
}

export async function sizes(args: string[]): Promise<number> {
  const usage = `db sizes\n\nLists tables ordered by disk size (Postgres, MySQL/MariaDB, and SQLite row counts + file size).\n\n${HOSTS_NOTE}`
  const { values } = parse(args, usage, { ...connectionOptions, ...catalogOptions }, { exits: EXITS })
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const rows = await withReadSession(url, async (tx, dialect) => {
    if (dialect === 'sqlite') {
      const list = await tx.unsafe(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
      const filePath = sqliteFilePath(url)
      const fileBytes = filePath === ':memory:' ? 0 : statSync(filePath, { throwIfNoEntry: false })?.size ?? 0
      const out: Row[] = []

      for (const row of list) {
        const name = String(row.name ?? '')
        const [counted] = await tx.unsafe(`select count(*) as n from ${quoteSqlite(name)}`)

        out.push({ schema: 'main', table: name, rows: Number(counted?.n ?? 0), db_file_size: formatSize(fileBytes) })
      }

      return out.toSorted((a, b) => Number(b.rows) - Number(a.rows))
    }

    return [...await tx.unsafe(dialect === 'postgres' ? PG_SIZES : MYSQL_SIZES)]
  }, undefined, statementTimeout(values))

  console.log(render(shape(rows, limit, true, true), values.json === true, values.format))

  return 0
}

function quoteFor(name: string, dialect: Dialect): string {
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`
}

export async function migrations(args: string[]): Promise<number> {
  const usage = `db migrations\n\nAuto-detects standard migration history tables (Doctrine, Prisma, Drizzle, Knex, TypeORM, Rails, Alembic, Flyway, Goose) and lists applied migrations.\n\n${HOSTS_NOTE}`
  const { values } = parse(args, usage, { ...connectionOptions, ...catalogOptions }, { exits: EXITS })
  const limit = rowLimit(values)
  const url = await connectionUrl(values)
  const result = await withReadSession(url, async (tx, dialect) => {
    let schemaTables: SchemaTable[]

    if (dialect === 'sqlite')
      schemaTables = await readSqliteSchema(tx)
    else if (dialect === 'postgres')
      schemaTables = await readPostgresSchema(tx)
    else
      schemaTables = await readMysqlSchema(tx)

    const hit = MIGRATION_TABLES.map(candidate => schemaTables.find(t => t.name.toLowerCase() === candidate)).find(each => each !== undefined)

    if (hit === undefined)
      return undefined

    const qualified = dialect === 'sqlite' ? quoteSqlite(hit.name) : `${quoteFor(hit.schema, dialect)}.${quoteFor(hit.name, dialect)}`
    const rows = [...await tx.unsafe(`select * from ${qualified}`)]

    return { table: hit.name, rows }
  }, undefined, statementTimeout(values))

  if (result === undefined) {
    if (values.json === true)
      console.log(jsonText({ table: null, rows: [] }, jsonValue))
    else
      console.log('no known migration table found')

    return 0
  }

  if (values.json === true)
    console.log(jsonText({ table: result.table, ...shape(result.rows, limit, true, true) }, jsonValue))
  else
    console.log(`${role('value', process.stdout)(result.table)}\n${render(shape(result.rows, limit, true, true), false, values.format)}`)

  return 0
}

export interface SchemaDiff {
  addedTables: string[]
  removedTables: string[]
  changedTables: { table: string, addedColumns: string[], removedColumns: string[], changedColumns: { column: string, from: string, to: string }[] }[]
}

export function diffSchemas(left: SchemaTable[], right: SchemaTable[]): SchemaDiff {
  const leftMap = new Map(left.map(t => [t.name, t]))
  const rightMap = new Map(right.map(t => [t.name, t]))
  const addedTables = [...rightMap.keys()].filter(name => !leftMap.has(name)).toSorted()
  const removedTables = [...leftMap.keys()].filter(name => !rightMap.has(name)).toSorted()
  const changedTables: SchemaDiff['changedTables'] = []

  for (const [name, leftTable] of [...leftMap.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const rightTable = rightMap.get(name)

    if (rightTable === undefined)
      continue

    const leftCols = new Map(leftTable.columns.map(c => [c.name, c]))
    const rightCols = new Map(rightTable.columns.map(c => [c.name, c]))
    const addedColumns = [...rightCols.keys()].filter(c => !leftCols.has(c))
    const removedColumns = [...leftCols.keys()].filter(c => !rightCols.has(c))
    const changedColumns: { column: string, from: string, to: string }[] = []

    for (const [colName, lCol] of leftCols) {
      const rCol = rightCols.get(colName)

      if (rCol === undefined)
        continue

      const lSig = `${lCol.type}${lCol.nullable ? '?' : ''}${lCol.primaryKey ? ' PK' : ''}`
      const rSig = `${rCol.type}${rCol.nullable ? '?' : ''}${rCol.primaryKey ? ' PK' : ''}`

      if (lSig !== rSig)
        changedColumns.push({ column: colName, from: lSig, to: rSig })
    }

    if (addedColumns.length > 0 || removedColumns.length > 0 || changedColumns.length > 0)
      changedTables.push({ table: name, addedColumns, removedColumns, changedColumns })
  }

  return { addedTables, removedTables, changedTables }
}

export async function diff(args: string[]): Promise<number> {
  const usage = `db diff [left.db right.db] [--against <db|file>] [--to-env <VAR>] [--to-file <path>] [--to-db <name>] [--json]\n\nCompares the schema (tables and columns) of two databases. Exits 0 when identical, 1 when they differ.\n\n${HOSTS_NOTE}`
  const { values, positionals } = parse(args, usage, {
    ...connectionOptions,
    'against': { type: 'string', description: 'second target: a SQLite file path or another database name on the same connection' },
    'to-file': { type: 'string', description: 'second SQLite file to compare against' },
    'to-env': { type: 'string', description: 'environment variable holding the second database URL' },
    'to-db': { type: 'string', description: 'second database name on the same server' },
    'json': jsonOption('{addedTables, removedTables, changedTables}'),
  }, { positionals: ['[left]', '[right]'], exits: EXITS })

  let leftUrl: string
  let rightUrl: string

  if (positionals.length === 2) {
    leftUrl = await connectionUrl({ ...values, file: positionals[0] })
    rightUrl = await connectionUrl({ ...values, file: positionals[1] })
  }
  else if (positionals.length === 0) {
    leftUrl = await connectionUrl(values)

    if (values['to-file'] !== undefined)
      rightUrl = await connectionUrl({ file: values['to-file'] })
    else if (values['to-env'] !== undefined)
      rightUrl = await connectionUrl({ 'env': values['to-env'], 'env-file': values['env-file'] })
    else if (values['to-db'] !== undefined)
      rightUrl = await connectionUrl({ ...values, database: values['to-db'] })
    else if (values.against !== undefined)
      rightUrl = isSqliteTarget(values.against) ? await connectionUrl({ file: values.against }) : await connectionUrl({ ...values, database: values.against })
    else
      fail('give two SQLite files (`db diff a.db b.db`) or pass --against / --to-file / --to-env / --to-db')
  }
  else {
    fail('give either two SQLite files or none (with --against / --to-file / --to-env / --to-db)')
  }

  const timeout = statementTimeout(values)
  const [leftSchema, rightSchema] = await Promise.all([readSchema(leftUrl, timeout), readSchema(rightUrl, timeout)])
  const result = diffSchemas(leftSchema, rightSchema)
  const same = result.addedTables.length === 0 && result.removedTables.length === 0 && result.changedTables.length === 0

  if (values.json === true) {
    console.log(jsonText(result, jsonValue))

    return same ? 0 : 1
  }

  if (same) {
    console.log('schemas match')

    return 0
  }

  const colors = paint(process.stdout)
  const rows: string[][] = [
    ...result.addedTables.map(name => [colors.green('+ table'), name, '']),
    ...result.removedTables.map(name => [colors.red('- table'), name, '']),
    ...result.changedTables.flatMap(t => [
      ...t.addedColumns.map(col => [colors.green('+ col'), `${t.table}.${col}`, '']),
      ...t.removedColumns.map(col => [colors.red('- col'), `${t.table}.${col}`, '']),
      ...t.changedColumns.map(col => [colors.yellow('~ col'), `${t.table}.${col.column}`, `${col.from} -> ${col.to}`]),
    ]),
  ]

  console.log(table(rows))

  return 1
}
