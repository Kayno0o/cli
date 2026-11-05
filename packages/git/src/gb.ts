#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { gb } from './branch'

process.exitCode = await runMain({ name: 'gb', run: gb })
