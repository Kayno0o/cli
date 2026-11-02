#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { query } from './commands/query'
import { databases, describe, tables } from './commands/schema'

process.exitCode = await runCli({
  name: 'db',
  version,
  about: 'read-only SQL against Postgres, MySQL and MariaDB, credentials never shown, writes only on a _test database',
  replaces: 'psql or mysql with the connection string on the command line, docker exec <container> psql -U ...',
  examples: ['db "select count(*) from users"', ['db -c booki-db-1 "select count(*) from users"', 'a container outside the compose project'], ['db describe users', 'the columns of a table']],
  commands: {
    query: { run: query, summary: 'run one read-only statement (the default: db "<sql>"), a write runs on a _test database and is printed otherwise' },
    tables: { run: tables, summary: 'list tables and views with an estimated row count' },
    describe: { run: describe, summary: 'columns of a table with type, nullability, default and primary key' },
    dbs: { run: databases, summary: 'databases the connection may open, with their size' },
  },
  defaultCommand: 'query',
})
