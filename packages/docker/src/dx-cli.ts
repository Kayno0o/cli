#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { dx } from './dx'

process.exitCode = await runMain({ name: 'dx', run: dx })
