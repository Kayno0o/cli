#!/usr/bin/env bun

import process from 'node:process'
import { fail, parse, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { run } from './run'

const USAGE = 'out [-n <lines>] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code'

async function main(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, { lines: { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' } }, { rest: true })

  const command = bare ? argv : parsed.rest ?? []

  if (command.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  return run(command, wholeNumber(parsed.values.lines, 'lines', 150))
}

process.exitCode = await runMain({ name: 'out', version, run: main })
