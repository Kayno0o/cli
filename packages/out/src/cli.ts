#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, copyOption, duration, fail, isStdinPiped, jsonOption, parse, printJson, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { FOLD_LINES } from './fold'
import { readPiped, run } from './run'
import { grepLog, printLast, printList, showLog } from './saved'
import { readEntries, renderSummary, statsPath, summarize } from './stats'

const USAGE = `out [-n <lines>] [--fold] -- <command> [args...]: runs the command and shortens its output when it is long, exiting with its code
<command> | out [-n <lines>]: shortens the output piped in
out logs [--json] / out --list: the saved logs across out, check and errs, newest first
out last [--copy] / out --last: the path of the most recent saved log
out grep [-i] [-C <n>] [--log <name>] [--json] <regex> / out --grep <regex>: matching lines with line numbers
out show [--log <name>] [--json] <from-to> / out --show <from-to>: a line range from a saved log
out stats [--since 7d] [--json] / out --stats: the runs recorded and tokens saved

On a human terminal, commands stream live with ANSI preserved unless --fold is passed; in agent, CI or pipe mode long output is folded and recognised build/test errors are surfaced first.`

const EXITS: ExitRow[] = [[0, 'the command did, or the output piped in was shortened, or the log was found'], ['its own', 'the code of a command that failed'], [1, '--grep matched nothing, --show is past EOF, or --list found no log'], [126, 'the command cannot be run (not executable)'], [127, 'the command cannot be started'], [2, 'a usage error, or no such saved log']]

const OPTIONS = {
  'lines': { type: 'string', short: 'n', description: 'longest output left untouched (default 150)' },
  'fold': { type: 'boolean', description: 'fold long output even on a human terminal' },
  'was': { type: 'string', multiple: true, description: 'a tail, head or grep stage out stands in for, so the stats count against what it would have printed (repeatable, in pipeline order)' },
  'last': { type: 'boolean', description: 'print the path of the most recent saved log' },
  'copy': copyOption('the path --last prints'),
  'list': { type: 'boolean', description: 'list saved logs across out, check and errs, newest first' },
  'grep': { type: 'string', description: 'print lines of a saved log matching this regular expression, with line numbers' },
  'ignore-case': { type: 'boolean', short: 'i', description: 'with --grep, match case-insensitively' },
  'context': { type: 'string', short: 'C', description: 'with --grep, lines of context around each match' },
  'show': { type: 'string', description: 'print a 1-indexed line or range (<line> or <from>-<to>) of a saved log' },
  'log': { type: 'string', description: 'with --grep or --show, the saved log to read (name or path) instead of the latest' },
  'stats': { type: 'boolean', description: 'print the runs recorded and the tokens saved' },
  'since': { type: 'string', description: 'with --stats, only the runs this recent (7d, 12h)' },
  'json': jsonOption('JSON output for --list, --grep, --show or --stats'),
} as const

// Normalizes subcommand forms (`out logs`, `out last`, `out grep <re>`, `out show 10-30`, `out stats`) into flag forms when not preceded by `--`.
function normalizeSubcommand(argv: string[]): string[] {
  const [first, ...rest] = argv

  if (first === 'logs')
    return ['--list', ...rest]

  if (first === 'last')
    return ['--last', ...rest]

  if (first === 'stats')
    return ['--stats', ...rest]

  if (first === 'grep') {
    const patternIndex = rest.findIndex((arg, idx) => !arg.startsWith('-') && (idx === 0 || (rest[idx - 1] !== '--log' && rest[idx - 1] !== '-C' && rest[idx - 1] !== '--context')))

    if (patternIndex === -1)
      return ['--grep']

    return ['--grep', rest[patternIndex]!, ...rest.slice(0, patternIndex), ...rest.slice(patternIndex + 1)]
  }

  if (first === 'show') {
    const spanIndex = rest.findIndex((arg, idx) => !arg.startsWith('-') && (idx === 0 || rest[idx - 1] !== '--log'))

    if (spanIndex === -1)
      return ['--show']

    return ['--show', rest[spanIndex]!, ...rest.slice(0, spanIndex), ...rest.slice(spanIndex + 1)]
  }

  return argv
}

async function stats(since: string | undefined, json: boolean): Promise<number> {
  const window = since === undefined ? undefined : duration(since, 'since', 0, 'h')
  const summary = summarize(await readEntries(statsPath(), window === undefined ? 0 : Date.now() - window))

  if (json)
    printJson(summary)
  else
    console.log(renderSummary(summary, since === undefined ? 'recorded' : `in the last ${since}`))

  return 0
}

async function main(rawArgv: string[]): Promise<number> {
  const argv = normalizeSubcommand(rawArgv)
  // A first word that is no option starts the command, a `--` before it or not.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true, exits: EXITS, replaces: 'piping a noisy command through tail or head', examples: ['out -- bun install', ['out -n 300 -- bun run build', 'up to 300 lines left untouched'], ['bun run build 2>&1 | out', 'what is piped in'], ['out logs', 'list saved logs from out, check and errs'], ['out show 1-40', 'inspect lines 1-40 of the latest log']] })
  const { values } = parsed

  const reads = [values.last === true, values.list === true, values.grep !== undefined, values.show !== undefined, values.stats === true].filter(Boolean).length

  if (reads > 1)
    badUsage('give one of --last, --list, --grep, --show and --stats')

  if (reads === 1 && ((parsed.rest ?? []).length > 0 || parsed.positionals.length > 0))
    badUsage('--last, --list, --grep, --show and --stats run no command')

  if (values.copy === true && values.last !== true)
    badUsage('--copy goes with --last')

  if (values.log !== undefined && values.grep === undefined && values.show === undefined)
    badUsage('--log goes with --grep or --show')

  if ((values['ignore-case'] === true || values.context !== undefined) && values.grep === undefined)
    badUsage('-i and -C go with --grep')

  if (values.last === true)
    return printLast(values.copy === true)

  if (values.list === true)
    return printList(values.json === true)

  if (values.grep !== undefined)
    return grepLog(values.grep, values.log, { ignoreCase: values['ignore-case'] === true, context: values.context === undefined ? 0 : wholeNumber(values.context, 'context', 0, 0), json: values.json === true })

  if (values.show !== undefined)
    return showLog(values.show, values.log, values.json === true)

  if (values.stats === true)
    return stats(values.since, values.json === true)

  if (values.since !== undefined || values.json === true)
    badUsage('--since goes with --stats; --json goes with --list, --grep, --show or --stats')

  const command = bare ? argv : parsed.rest ?? []
  const lines = wholeNumber(values.lines, 'lines', FOLD_LINES)
  const was = values.was ?? []

  if (command.length === 0 && parsed.positionals.length === 0 && isStdinPiped())
    return readPiped(lines, was)

  if (command.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  return run(command, lines, { was, forceFold: values.fold === true })
}

process.exitCode = await runMain({ name: 'out', run: main })
