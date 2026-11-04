#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { peek } from './peek'

process.exitCode = await runMain({ name: 'peek', run: peek })
