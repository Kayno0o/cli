#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { sf } from './sf'

process.exitCode = await runMain({ name: 'sf', run: sf })
