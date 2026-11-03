#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { dx } from './dx'

process.exitCode = await runMain({ name: 'dx', version, run: dx })
