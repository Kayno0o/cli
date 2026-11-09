#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { DEFAULT_HEIGHT, parseHeight, rank, select } from '@kaynooo/cli-kit/picker'
import { parseFields, pickFields } from './fields'

const USAGE = `pick [options]: a fuzzy selector, the lines on stdin in, the chosen one on stdout out

Type to filter: the query matches as a subsequence, best matches first (a word start, a run of characters or a prefix scores higher; a lowercase query ignores case, an uppercase letter makes it exact). Up and down or ctrl-p and ctrl-n move, enter picks, esc and ctrl-c cancel, left, right, ctrl-a and ctrl-e move in the query (ctrl or alt for a word), ctrl-u and ctrl-k erase back to its start and on to its end, ctrl-y puts back what they erased, ctrl-z suspends, ctrl-/ or f1 shows the keys.
The keys are read from the terminal and the selector is drawn on stderr, so \`pick\` in a pipe or a command substitution prints only the choice. With --multi, tab marks the highlighted line and enter prints the marked lines in input order (the highlighted one when none is marked).
--preview runs a command for the highlighted line, \`{}\` standing for it shell-quoted, in a pane on the right when the terminal is at least 80 columns wide; its output is cut at 64 KiB and 200 lines.

--delimiter splits each line into fields (a regex, whitespace by default), --nth names the fields the query is matched against and --with-nth the ones shown, in fzf's syntax: 1-based, \`-1\` the last, \`2..\`, \`..3\`, \`2..4\`, comma-separated. The printed line is always the whole input line. --read0 reads NUL-separated lines and --print0 ends each printed one with NUL.
--filter takes the query and prints every match best first with no terminal; --select-1 prints the only match without opening the selector, --exit-0 exits 1 at once when nothing matches.

Without a terminal on stderr there is nobody to choose: it prints the best line the query matches, as the selector would rank it, or every match best first with --multi.`
const EXITS: ExitRow[] = [[0, 'it printed a choice'], [1, 'nothing matches or there are no lines'], [2, 'a usage error'], [130, 'cancelled']]

const OPTIONS = {
  'multi': { type: 'boolean', short: 'm', description: 'tab marks several lines, enter prints them' },
  'prompt': { type: 'string', short: 'p', description: 'the prompt before the query (> )' },
  // -q is the query here, not quiet: it predates the convention and pick has nothing to silence.
  'query': { type: 'string', short: 'q', description: 'the query to start with' },
  'preview': { type: 'string', description: 'a command shown for the highlighted line, {} standing for it' },
  'header': { type: 'string', description: 'a line of text shown above the list' },
  'filter': { type: 'string', short: 'f', description: 'print every line the query matches, best first, with no terminal' },
  'select-1': { type: 'boolean', short: '1', description: 'print the only match without opening the selector' },
  'exit-0': { type: 'boolean', short: '0', description: 'exit 1 at once when nothing matches' },
  'delimiter': { type: 'string', short: 'd', description: 'a regex splitting a line into fields (whitespace)' },
  'nth': { type: 'string', description: 'the fields the query is matched against, 2, -1, 2.., 1..3, 1,3' },
  'with-nth': { type: 'string', description: 'the fields shown, the printed line stays whole' },
  'read0': { type: 'boolean', description: 'lines on stdin end with NUL' },
  'print0': { type: 'boolean', description: 'end each printed line with NUL' },
  'height': { type: 'string', description: 'lines or a percentage of the terminal to draw in (100%)' },
  'json': jsonOption('{picked: [lines]}, the choice or the marked lines in input order'),
} as const

function print(chosen: string[], json: boolean, end: string): void {
  if (json)
    printJson({ picked: chosen })
  else
    process.stdout.write(chosen.map(line => line + end).join(''))
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, replaces: 'fzf for a quick choice in a pipe, select in a shell script', examples: ['git branch --format=\'%(refname:short)\' | pick', 'ls | pick --multi --preview \'head -20 {}\'', 'git branch | pick --filter main  # every match, best first, no terminal', 'ps aux | pick --with-nth 2,11.. --nth 11..  # show some fields, search others'] })

  if (positionals.length > 0)
    badUsage('pick takes its lines on stdin, not as arguments')

  const height = values.height === undefined ? DEFAULT_HEIGHT : parseHeight(values.height)

  if (height === undefined)
    badUsage(`--height takes a number of lines or a percentage such as 40%, not ${values.height}`)

  if (process.stdin.isTTY)
    badUsage('pipe the lines to pick on stdin')

  const fieldsOf = (name: 'nth' | 'with-nth'): ((count: number) => number[]) | undefined => {
    const text = values[name]

    if (text === undefined)
      return undefined

    return parseFields(text) ?? badUsage(`--${name} takes fields such as 2, -1, 2.., 1..3 or 1,3, not ${text}`)
  }
  const nth = fieldsOf('nth')
  const withNth = fieldsOf('with-nth')
  let delimiter: RegExp | undefined

  try {
    delimiter = values.delimiter === undefined ? undefined : new RegExp(values.delimiter)
  }
  catch {
    badUsage(`--delimiter is a regex, not ${values.delimiter}`)
  }

  const lines = (await Bun.stdin.text()).split(values.read0 === true ? '\0' : '\n').filter(line => line !== '')

  if (lines.length === 0)
    fail('nothing to pick from', 1)

  const query = values.filter ?? values.query ?? ''
  const end = values.print0 === true ? '\0' : '\n'
  const json = values.json === true
  const searched = lines.map(line => nth === undefined ? line : pickFields(line, nth, delimiter))
  const matching = rank(query, searched).map(({ index }) => lines[index]!)

  if (matching.length === 0 && (values['exit-0'] === true || values.filter !== undefined || !process.stderr.isTTY))
    return 1

  // Nobody to choose, so the lines the query matches are the choice: all of them with --multi or --filter, else the first.
  if (values.filter !== undefined || !process.stderr.isTTY) {
    print(values.multi === true || values.filter !== undefined ? matching : matching.slice(0, 1), json, end)

    return 0
  }

  if (values['select-1'] === true && matching.length === 1) {
    print(matching, json, end)

    return 0
  }

  const rows = lines.map((line, index) => ({ hidden: [line], cells: [withNth === undefined ? line : pickFields(line, withNth, delimiter).trimEnd()], ...nth === undefined ? {} : { search: searched[index]! } }))
  const picked = await select(rows, { multi: values.multi === true, prompt: values.prompt ?? '> ', query, height, preview: values.preview, header: values.header })

  if (picked === undefined)
    return 130

  print(picked.rows.map(row => row.hidden[0]!), json, end)

  return 0
}

process.exitCode = await runMain({ name: 'pick', run: main })
