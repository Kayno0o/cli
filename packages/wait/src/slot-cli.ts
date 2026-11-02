#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { listSlots, runSlotted } from './slot'

process.exitCode = await runMain({ name: 'slot', version, run: async args => args[0] === 'ls' ? listSlots(args.slice(1)) : runSlotted(args) })
