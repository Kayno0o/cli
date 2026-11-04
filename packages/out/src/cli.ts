#!/usr/bin/env bun

import process from 'node:process'
import { badUsage, duration, fail, isStdinPiped, jsonOption, parse, printJson, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { FOLD_LINES } from './fold'
import { readPiped, run } from './run'
import { readEntries, renderSummary, statsPath, summarize } from './stats'

const USAGE = 'out [-n <lines>] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code\n<command> | out [-n <lines>]: shortens the output piped in\nout --stats [--since 7d] [--json]: the runs recorded and about how many tokens they saved\n\nEach run is recorded in ~/.local/state/kaynooo-cli/out/stats.jsonl with the words naming the command, never its arguments; tokens are counted as bytes / 4.\nExits 0 when the command does, with its own code otherwise, 126 when it cannot be run (not executable), 127 when it cannot be started, 2 on a usage error. Piped into, it exits 0.'

const OPTIONS = {
  lines: { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' },
  was: { type: 'string', multiple: true, description: 'a tail, head or grep stage out stands in for, so the stats count against what it would have printed (repeatable, in pipeline order)' },
  stats: { type: 'boolean', description: 'print the runs recorded and the tokens saved' },
  since: { type: 'string', description: 'with --stats, only the runs this recent (7d, 12h)' },
  json: jsonOption('with --stats, {runs, folded, bytes, shown, tokensSaved, commands}'),
} as const

async function stats(since: string | undefined, json: boolean): Promise<number> {
  const window = since === undefined ? undefined : duration(since, 'since', 0, 'h')
  const summary = summarize(await readEntries(statsPath(), window === undefined ? 0 : Date.now() - window))

  if (json)
    printJson(summary)
  else
    console.log(renderSummary(summary, since === undefined ? 'recorded' : `in the last ${since}`))

  return 0
}

async function main(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true, replaces: 'piping a noisy command through tail or head', examples: ['out -- bun install', ['out -n 300 -- bun run build', 'up to 300 lines left untouched'], ['bun run build 2>&1 | out', 'what is piped in'], ['out --stats --since 7d', 'the tokens saved this week']] })
  const { values } = parsed

  if (values.stats === true) {
    if ((parsed.rest ?? []).length > 0 || parsed.positionals.length > 0)
      badUsage('--stats runs no command')

    return stats(values.since, values.json === true)
  }

  if (values.since !== undefined || values.json === true)
    badUsage('--since and --json go with --stats')

  const command = bare ? argv : parsed.rest ?? []
  const lines = wholeNumber(values.lines, 'lines', FOLD_LINES)
  const was = values.was ?? []

  if (command.length === 0 && parsed.positionals.length === 0 && isStdinPiped())
    return readPiped(lines, was)

  if (command.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  return run(command, lines, was)
}

process.exitCode = await runMain({ name: 'out', version, run: main })
