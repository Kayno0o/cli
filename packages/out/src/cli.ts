#!/usr/bin/env bun

import process from 'node:process'
import { Exit, fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { run } from './run'

const USAGE = 'out [-n <lines>] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code'

// Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
function split(argv: string[]): { own: string[], command: string[] } {
  if (argv[0] !== undefined && !argv[0].startsWith('-'))
    return { own: [], command: argv }

  const separator = argv.indexOf('--')

  return separator === -1 ? { own: argv, command: [] } : { own: argv.slice(0, separator), command: argv.slice(separator + 1) }
}

async function main(argv: string[]): Promise<number> {
  const { command, own } = split(argv)

  if (own[0] === '--version' || own[0] === '-v') {
    console.log(version)

    return 0
  }

  const parsed = parse(own, USAGE, { lines: { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' } })

  if (parsed === undefined)
    return 0

  if (command.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  return run(command, wholeNumber(parsed.values.lines, 'lines', 150))
}

try {
  process.exitCode = await main(process.argv.slice(2))
}
catch (error) {
  console.error(`out: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = error instanceof Exit ? error.code : 1
}
