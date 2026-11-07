#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { analyze } from './analyze'
import { render } from './render'

const USAGE = `gloss [options] <command line>: explains a shell command line, each option matched to what its man page says

Quote the command line or put it after --: gloss -- tar -xzvf a.tgz. Without arguments the command line is read from stdin.
Pipes, && and ||, redirects, variable assignments and $(...) substitutions are explained too. A command is looked up in the man pages on this machine (a subcommand such as git commit in git-commit); one with no man page is listed with its words unexplained, unless --run-help reads its options from '<command> --help': that runs the command (only a bare name found on PATH, no stdin, 3 seconds), so use it for commands you trust.`

const EXITS: ExitRow[] = [[0, 'it explained the line'], [2, 'a usage error']]

const OPTIONS = {
  'run-help': { type: 'boolean', description: 'for a command with no man page, run `<command> --help` and read its options (runs the command)' },
  'json': jsonOption('{line, commands: [{name, page, source, summary, notes, redirects, substitutions, next}]}'),
} as const

const PLAIN = /^[\w@%+=:,./-]+$/

function quote(word: string): string {
  return PLAIN.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`
}

async function main(args: string[]): Promise<number> {
  const { values, positionals, rest } = parse(args, USAGE, OPTIONS, { rest: true, exits: EXITS, replaces: 'explainshell in a browser, reading man pages for each flag', examples: ['gloss \'tar -xzvf a.tgz -C /tmp\'', 'gloss -- git commit -am fix'] })
  const typed = [...positionals.map(String), ...(rest ?? []).map(quote)].join(' ')
  const line = typed === '' && !process.stdin.isTTY ? (await Bun.stdin.text()).trim() : typed

  if (line === '')
    badUsage('give the command line to explain, quoted or after --')

  const result = analyze(line, { runHelp: values['run-help'] === true })

  if (values.json === true)
    printJson(result)
  else
    console.log(render(result, process.stdout).join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gloss', run: main })
