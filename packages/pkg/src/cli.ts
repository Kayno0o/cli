#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { check } from './commands/check'

process.exitCode = await runMain({ name: 'pkg', version, run: check })
