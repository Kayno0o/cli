#!/usr/bin/env bun

import process from 'node:process'
import { runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { pid } from './pid'

process.exitCode = await runMain({ name: 'pid', version, run: pid })
