#!/usr/bin/env -S bun --config=/dev/null

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { explain } from './commands/explain'
import { query } from './commands/query'
import { databases, describe, search, tables } from './commands/schema'
import { count, sample } from './commands/table'

process.exitCode = await runCli({
  name: 'db',
  about: 'read-only SQL against Postgres, MySQL and MariaDB, credentials never shown, writes only on a _test database',
  replaces: 'psql or mysql with the connection string on the command line, docker exec <container> psql -U ...',
  examples: ['db "select count(*) from users"', ['db -c booki-db-1 "select count(*) from users"', 'a container outside the compose project'], ['db describe users', 'the columns, indexes and foreign keys of a table'], ['db search email', 'where a field lives'], ['db explain "select * from users where email = \'a\'"', 'the plan, nothing executed'], ['db --format csv "select id, email from users"', 'RFC 4180 CSV, or tsv or vertical']],
  commands: {
    query: { run: query, summary: 'run one read-only statement (the default: db "<sql>"), a write runs on a _test database and is printed otherwise' },
    tables: { run: tables, summary: 'list tables and views with an estimated row count' },
    describe: { run: describe, summary: 'columns of a table with type, nullability, default and primary key, then its indexes and foreign keys' },
    search: { run: search, summary: 'find the tables and columns whose name contains a text' },
    explain: { run: explain, summary: 'the plan of one read, run and timed with --analyze (in the rolled-back read-only transaction)' },
    sample: { run: sample, summary: 'a few rows of a table, sensitive columns masked' },
    count: { run: count, summary: 'the number of rows of a table, optionally matching --where' },
    dbs: { run: databases, summary: 'databases the connection may open, with their size' },
  },
  defaultCommand: 'query',
})
