#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { j } from './j'

process.exitCode = await runMain({ name: 'j', version, run: j })
