#!/usr/bin/env bun

import { fstatSync } from 'node:fs'
import process from 'node:process'
import { fail, parse, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { readPiped, run } from './run'

const USAGE = 'out [-n <lines>] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code\n<command> | out [-n <lines>]: shortens the output piped in\n\nExits 0 when the command does, with its own code otherwise, 127 when it cannot be started, 2 on a usage error. Piped into, it exits 0.'

// Whether stdin is a pipe or a file to read, rather than a terminal or /dev/null that would leave `out` waiting or reading nothing.
function isPiped(): boolean {
  const stat = fstatSync(0)

  return stat.isFIFO() || stat.isFile()
}

async function main(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, { lines: { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' } }, { rest: true, replaces: 'piping a noisy command through tail or head', examples: ['out -- bun install', ['out -n 300 -- bun run build', 'up to 300 lines left untouched'], ['bun run build 2>&1 | out', 'what is piped in']] })

  const command = bare ? argv : parsed.rest ?? []
  const lines = wholeNumber(parsed.values.lines, 'lines', 150)

  if (command.length === 0 && parsed.positionals.length === 0 && isPiped())
    return readPiped(lines)

  if (command.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  return run(command, lines)
}

process.exitCode = await runMain({ name: 'out', version, run: main })
