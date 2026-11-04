#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { redact } from './commands/redact'

process.exitCode = await runMain({ name: 'redact', run: redact })
