#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { main } from './doctor'

process.exitCode = await runMain({ name: 'doctor', run: async args => main(args) })
