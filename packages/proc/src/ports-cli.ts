#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { ports } from './ports'

process.exitCode = await runMain({ name: 'ports', version, run: ports })
