#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { redact } from './commands/redact'

process.exitCode = await runMain({ name: 'redact', run: redact })
