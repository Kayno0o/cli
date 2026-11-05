#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { main } from './doctor'

process.exitCode = await runMain({ name: 'doctor', run: async args => main(args) })
