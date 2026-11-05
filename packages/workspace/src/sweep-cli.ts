#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { sweep } from './sweep'

process.exitCode = await runMain({ name: 'sweep', run: sweep })
