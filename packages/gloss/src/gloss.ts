#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'
import { analyze } from './analyze'
import { render } from './render'

const USAGE = `gloss [options] <command line>: explains a shell command line, each option matched to what its man page says

Pass a bare command directly (gloss tar -xzvf a.tgz), quote a pipeline (gloss 'tar -xzf a.tgz | head'), put it after --, or pipe it on stdin.
Unwraps sudo, env, out, slot and similar wrappers automatically, handles git global flags before subcommands, and caches parsed man pages.
A command is looked up in the man pages on this machine; one with no man page is listed with its words unexplained, unless --run-help reads its options from '<command> --help' (or KIT_HELP=json for @kaynooo/cli tools), which runs the command (a program found on PATH only, 3 seconds), so use it for commands you trust.`

const EXITS: ExitRow[] = [[0, 'it explained the line'], [2, 'a usage error']]

const OPTIONS = {
  'run-help': { type: 'boolean', description: 'for a command with no man page, run `<command> --help` and read its options (runs the command)' },
  'json': jsonOption('{line, commands: [{name, page, source, summary, wrappers?, notes, redirects, substitutions, next}]}'),
} as const

const OWN_FLAGS = new Set(['--run-help', '--json', '--plain', '--no-color', '--agent', '--human', '-h', '--help', '--help=json', '-v', '--version'])

// Allows bare commands like `gloss tar -xzf a.tgz` or `gloss slot -- tar -xzf a.tgz` without a leading `--`, while rejecting unknown leading flags (`gloss --bogus`) via `parse`.
function normalizeArgs(args: string[]): string[] {
  let firstPositional = -1

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!

    // An explicit `--` before any positional already separates gloss flags from the command.
    if (token === '--')
      return args

    if (token.startsWith('-') && token !== '-') {
      if (!OWN_FLAGS.has(token))
        return args

      continue
    }

    firstPositional = i

    break
  }

  if (firstPositional === -1)
    return args

  const tail = args.slice(firstPositional + 1)

  if (tail.every(token => OWN_FLAGS.has(token)))
    return args

  return [...args.slice(0, firstPositional), '--', ...args.slice(firstPositional)]
}

async function main(args: string[]): Promise<number> {
  const normalized = normalizeArgs(args)
  const { values, positionals, rest } = parse(normalized, USAGE, OPTIONS, { rest: true, exits: EXITS, replaces: 'explainshell in a browser, reading man pages for each flag', examples: ['gloss tar -xzvf a.tgz -C /tmp', 'gloss \'tar -xzvf a.tgz | head\'', 'gloss git -C /repo commit -am fix'] })
  const typed = rest !== undefined && rest.length > 0
    ? [...positionals.map(String), ...(rest.length === 1 && positionals.length === 0 && !args.includes('--') ? rest : rest.map(shellQuote))].join(' ')
    : positionals.map(String).join(' ')
  const line = typed === '' && !process.stdin.isTTY ? (await Bun.stdin.text()).trim() : typed

  if (line === '')
    badUsage('give the command line to explain, directly, quoted or after --')

  const result = analyze(line, { runHelp: values['run-help'] === true })

  if (values.json === true)
    printJson(result)
  else
    console.log(render(result, process.stdout).join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gloss', run: main })
