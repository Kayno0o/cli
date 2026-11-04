#!/usr/bin/env -S bun --no-env-file

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { pid } from './pid'

process.exitCode = await runMain({ name: 'pid', run: pid })
