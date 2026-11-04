#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { dlog } from './dlog'

process.exitCode = await runMain({ name: 'dlog', run: dlog })
