#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { listSlots, runSlotted } from './slot'

process.exitCode = await runMain({ name: 'slot', run: async args => args[0] === 'ls' ? listSlots(args.slice(1)) : runSlotted(args) })
