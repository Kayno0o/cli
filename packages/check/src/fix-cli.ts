#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { fix } from './fix'

process.exitCode = await runMain({ name: 'fix', version, run: async args => fix(args) })
