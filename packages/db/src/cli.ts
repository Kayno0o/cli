#!/usr/bin/env bun

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { query } from './commands/query'
import { describe, tables } from './commands/schema'

process.exitCode = await runCli({
  name: 'db',
  version,
  about: 'read-only SQL against Postgres, credentials never shown',
  commands: {
    query: { run: query, summary: 'run one read-only statement (the default: db "<sql>"), a write is printed instead' },
    tables: { run: tables, summary: 'list tables and views with an estimated row count' },
    describe: { run: describe, summary: 'columns of a table with type, nullability, default and primary key' },
  },
  defaultCommand: 'query',
})
