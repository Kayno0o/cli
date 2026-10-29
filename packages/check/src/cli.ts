#!/usr/bin/env bun

import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'
import { check } from './check'

try {
  process.exitCode = await check(process.argv.slice(2))
}
catch (error) {
  console.error(`check: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = error instanceof Exit ? error.code : 1
}
