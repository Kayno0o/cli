#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { procs } from './procs'

process.exitCode = await runMain({ name: 'procs', run: procs })
