#!/usr/bin/env bun

import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { check } from './commands/check'

// kit's runCli dispatches on a command name, and pkg has a single job, so it runs the command itself.
try {
  const args = process.argv.slice(2)

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(version)
    process.exitCode = 0
  }
  else {
    process.exitCode = await check(args)
  }
}
catch (error) {
  console.error(`pkg: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = error instanceof Exit ? error.code : 1
}
