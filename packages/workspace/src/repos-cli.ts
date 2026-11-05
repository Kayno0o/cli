#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { repos } from './repos'

process.exitCode = await runMain({ name: 'repos', run: repos })
