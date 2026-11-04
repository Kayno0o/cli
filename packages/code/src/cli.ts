#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runCli } from '@kaynooo/cli-kit'
import { hotspots } from './hotspots'
import { peek } from './peek'
import { todoScan } from './todo-scan'

process.exitCode = await runCli({
  name: 'src',
  about: 'reads and ranks the source of a folder: line spans, TODO comments and the files worth splitting',
  replaces: 'sed -n N,Mp, grep -n chains and grep -rn TODO',
  examples: ['src peek src/cli.ts:10-40', 'src todo-scan', ['src hotspots -n 10', 'the ten files both complex and often edited']],
  commands: {
    'peek': { summary: 'files or line spans with their line numbers, several in one call', run: peek },
    'todo-scan': { summary: 'the TODO, FIXME and owner/repo#N comments under the paths', run: todoScan },
    'hotspots': { summary: 'the source files ranked by complexity times git churn', run: hotspots },
  },
})
