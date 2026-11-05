#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { hotspots } from './hotspots'

process.exitCode = await runMain({ name: 'hotspots', run: hotspots })
