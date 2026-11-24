#!/usr/bin/env -S bun --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { explain } from './commands/explain'
import { activity, ddl, diff, locks, migrations, schema, sizes } from './commands/inspect'
import { query } from './commands/query'
import { databases, describe, search, tables } from './commands/schema'
import { count, sample } from './commands/table'

process.exitCode = await runCli({
  name: 'db',
  about: 'read-only SQL against Postgres, MySQL, MariaDB and SQLite, credentials never shown, writes only on a _test database',
  replaces: 'psql, mysql or sqlite3 with the connection string on the command line, docker exec <container> psql -U ...',
  examples: [
    'db "select count(*) from users"',
    ['db ./app.db "select count(*) from users"', 'query a local SQLite file directly'],
    ['db schema', 'compact map of all tables, columns, PKs, and FKs'],
    ['db describe users', 'columns, indexes and foreign keys of a table'],
    ['db sample users --latest', 'newest rows of a table, sensitive columns masked'],
    ['db explain "select * from users where email = \'a\'"', 'the plan, nothing executed'],
  ],
  commands: {
    query: { run: query, summary: 'run one read-only statement (the default: db "<sql>" or db ./app.db "<sql>")' },
    schema: { run: schema, summary: 'compact 1-shot map of all tables, columns, primary keys, and foreign keys' },
    tables: { run: tables, summary: 'list tables and views with an estimated row count' },
    describe: { run: describe, summary: 'columns, indexes and foreign keys of a table (one connection)' },
    ddl: { run: ddl, summary: 'CREATE TABLE and CREATE INDEX DDL for a table' },
    search: { run: search, summary: 'find tables and columns whose name contains a text' },
    explain: { run: explain, summary: 'query plan of one read, run and timed with --analyze' },
    sample: { run: sample, summary: 'a few rows of a table (--latest / --order / --where), sensitive columns masked' },
    count: { run: count, summary: 'row count of a table, optionally matching --where' },
    sizes: { run: sizes, summary: 'tables ordered by disk size or row count' },
    activity: { run: activity, summary: 'active connections and running queries (Postgres/MySQL)' },
    locks: { run: locks, summary: 'active locks and transactions (Postgres/MySQL)' },
    migrations: { run: migrations, summary: 'applied migrations from auto-detected migration history table' },
    diff: { run: diff, summary: 'compare schemas (tables and columns) between two databases' },
    dbs: { run: databases, summary: 'databases the connection may open, with their size' },
  },
  defaultCommand: 'query',
})
