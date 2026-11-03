#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { sf } from './sf'

process.exitCode = await runMain({ name: 'sf', version, run: sf })
