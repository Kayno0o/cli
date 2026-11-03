#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { procs } from './procs'

process.exitCode = await runMain({ name: 'procs', version, run: procs })
