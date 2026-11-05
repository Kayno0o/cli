#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { ports } from './ports'

process.exitCode = await runMain({ name: 'ports', run: ports })
