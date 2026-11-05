#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { choose, DEFAULT_HEIGHT, parseHeight } from '@kaynooo/cli-kit/picker'

const USAGE = `pick [options]: a fuzzy selector, the lines on stdin in, the chosen one on stdout out

Type to filter: the query matches as a subsequence, best matches first (a word start, a run of characters or a prefix scores higher; a lowercase query ignores case, an uppercase letter makes it exact). Up and down or ctrl-p and ctrl-n move, enter picks, esc and ctrl-c cancel, ctrl-u clears the query, ctrl-/ or f1 shows the keys.
The keys are read from the terminal and the selector is drawn on stderr, so \`pick\` in a pipe or a command substitution prints only the choice. With --multi, tab marks the highlighted line and enter prints the marked lines in input order (the highlighted one when none is marked).
--preview runs a command for the highlighted line, \`{}\` standing for it shell-quoted, in a pane on the right when the terminal is at least 80 columns wide; its output is cut at 64 KiB and 200 lines.

Without a terminal on stderr there is nobody to choose: it prints the first line containing the query (case-insensitive), every one with --multi.

Exits 0 when it printed a choice, 1 when cancelled, nothing matches or there are no lines, 2 on a usage error.`

const OPTIONS = {
  multi: { type: 'boolean', short: 'm', description: 'tab marks several lines, enter prints them' },
  prompt: { type: 'string', short: 'p', description: 'the prompt before the query (> )' },
  query: { type: 'string', short: 'q', description: 'the query to start with' },
  preview: { type: 'string', description: 'a command shown for the highlighted line, {} standing for it' },
  height: { type: 'string', description: 'lines or a percentage of the terminal to draw in (100%)' },
  json: jsonOption('{picked: [lines]}, the choice or the marked lines in input order'),
} as const

function print(chosen: string[], json: boolean): void {
  if (json)
    printJson({ picked: chosen })
  else
    process.stdout.write(`${chosen.join('\n')}\n`)
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { replaces: 'fzf for a quick choice in a pipe, select in a shell script', examples: ['git branch --format=\'%(refname:short)\' | pick', 'ls | pick --multi --preview \'head -20 {}\''] })

  if (positionals.length > 0)
    badUsage('pick takes its lines on stdin, not as arguments')

  const height = values.height === undefined ? DEFAULT_HEIGHT : parseHeight(values.height)

  if (height === undefined)
    badUsage(`--height takes a number of lines or a percentage such as 40%, not ${values.height}`)

  if (process.stdin.isTTY)
    badUsage('pipe the lines to pick on stdin')

  const lines = (await Bun.stdin.text()).split('\n').filter(line => line !== '')

  if (lines.length === 0)
    fail('nothing to pick from', 1)

  // Nobody to choose, so the lines the query matches are the choice: all of them with --multi, else the first.
  if (!process.stderr.isTTY) {
    const query = (values.query ?? '').toLowerCase()
    const matching = lines.filter(line => line.toLowerCase().includes(query))

    if (matching.length === 0)
      return 1

    print(values.multi === true ? matching : matching.slice(0, 1), values.json === true)

    return 0
  }

  const picked = await choose(lines, { multi: values.multi === true, prompt: values.prompt ?? '> ', query: values.query ?? '', height, preview: values.preview })

  if (picked === undefined)
    return 1

  print(picked, values.json === true)

  return 0
}

process.exitCode = await runMain({ name: 'pick', run: main })
