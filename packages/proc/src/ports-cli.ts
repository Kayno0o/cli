#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { ports } from './ports'

process.exitCode = await runMain({ name: 'ports', run: ports })
