#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, copyOption, duration, fail, isStdinPiped, jsonOption, parse, printJson, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { FOLD_LINES } from './fold'
import { readPiped, run } from './run'
import { grepLog, printLast, printList } from './saved'
import { readEntries, renderSummary, statsPath, summarize } from './stats'

const USAGE = 'out [-n <lines>] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code\n<command> | out [-n <lines>]: shortens the output piped in\nout --stats [--since 7d] [--json]: the runs recorded and about how many tokens they saved\nout --last: the path of the most recent full log\nout --list: the saved logs, the newest first\nout --grep <regex> [--log <name>]: the lines of a saved log (the last by default) matching the regex, with their line numbers\n\nEach run is recorded in ~/.local/state/kaynooo-cli/out/stats.jsonl with the words naming the command, never its arguments; tokens are counted as bytes / 4.'

const EXITS: ExitRow[] = [[0, 'the command did, or the output piped in was shortened, or the log was found'], ['its own', 'the code of a command that failed'], [1, '--grep matched nothing, or --list found no log'], [126, 'the command cannot be run (not executable)'], [127, 'the command cannot be started'], [2, 'a usage error, or no such saved log']]

const OPTIONS = {
  lines: { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' },
  was: { type: 'string', multiple: true, description: 'a tail, head or grep stage out stands in for, so the stats count against what it would have printed (repeatable, in pipeline order)' },
  last: { type: 'boolean', description: 'print the path of the most recent full log' },
  copy: copyOption('the path --last prints'),
  list: { type: 'boolean', description: 'list the saved logs, the newest first' },
  grep: { type: 'string', description: 'print the lines of a saved log matching this regular expression, with their line numbers' },
  log: { type: 'string', description: 'with --grep, the saved log to read (its name or path) instead of the last' },
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
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true, exits: EXITS, replaces: 'piping a noisy command through tail or head', examples: ['out -- bun install', ['out -n 300 -- bun run build', 'up to 300 lines left untouched'], ['bun run build 2>&1 | out', 'what is piped in'], ['out --stats --since 7d', 'the tokens saved this week']] })
  const { values } = parsed

  const reads = [values.last === true, values.list === true, values.grep !== undefined, values.stats === true].filter(Boolean).length

  if (reads > 1)
    badUsage('give one of --last, --list, --grep and --stats')

  if (reads === 1 && ((parsed.rest ?? []).length > 0 || parsed.positionals.length > 0))
    badUsage('--last, --list, --grep and --stats run no command')

  if (values.copy === true && values.last !== true)
    badUsage('--copy goes with --last')

  if (values.log !== undefined && values.grep === undefined)
    badUsage('--log goes with --grep')

  if (values.last === true)
    return printLast(values.copy === true)

  if (values.list === true)
    return printList()

  if (values.grep !== undefined)
    return grepLog(values.grep, values.log)

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

process.exitCode = await runMain({ name: 'out', run: main })
