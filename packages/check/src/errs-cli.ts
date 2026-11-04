#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { errs } from './errs'

process.exitCode = await runMain({ name: 'errs', version, run: async args => errs(args) })
