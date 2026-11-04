#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { dx } from './dx'

process.exitCode = await runMain({ name: 'dx', run: dx })
