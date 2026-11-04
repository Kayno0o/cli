#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { proof } from './proof'

process.exitCode = await runMain({ name: 'proof', run: proof })
