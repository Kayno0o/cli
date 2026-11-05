#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { todoScan } from './todo-scan'

process.exitCode = await runMain({ name: 'todo-scan', run: todoScan })
