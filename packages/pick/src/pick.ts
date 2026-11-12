#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { DEFAULT_HEIGHT, parseHeight, rank, select } from '@kaynooo/cli-kit/picker'
import { parseFields, pickFields } from './fields'

const USAGE = `pick [options]: a fuzzy selector, the lines on stdin in, the chosen one on stdout out

Type to filter: the query matches as a subsequence, best matches first, and ctrl-/ or f1 shows the keys; enter picks, esc and ctrl-c cancel.
The keys are read from the terminal and the selector is drawn on stderr, so \`pick\` in a pipe or a command substitution prints only the choice. With --multi, tab marks lines and enter prints them in input order.
--delimiter, --nth and --with-nth split lines into fields in fzf's syntax, and the printed line is always the whole input line.
Without a terminal on stderr it prints the best match, or every match with --multi.`
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

// The chosen lines as JSON, or each as the bytes it came in (a name that is not UTF-8 kept as it is) followed by `end`.
function print(chosen: string[], json: boolean, end: string, bytesOf: Map<string, Uint8Array>): void {
  if (json)
    printJson({ picked: chosen })
  else
    process.stdout.write(Buffer.concat(chosen.flatMap(line => [bytesOf.get(line) ?? Buffer.from(line), Buffer.from(end)])))
}

// The non-empty runs of bytes between separators.
function splitBytes(bytes: Uint8Array, separator: number): Uint8Array[] {
  const parts: Uint8Array[] = []
  let start = 0

  for (let at = bytes.indexOf(separator); at !== -1; at = bytes.indexOf(separator, start)) {
    parts.push(bytes.subarray(start, at))
    start = at + 1
  }

  parts.push(bytes.subarray(start))

  return parts.filter(part => part.length > 0)
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

  // Lines are matched as text and printed as the bytes they came in.
  const raw = splitBytes(await Bun.stdin.bytes(), values.read0 === true ? 0 : 10)
  const decoder = new TextDecoder()
  const lines = raw.map(bytes => decoder.decode(bytes))
  const bytesOf = new Map<string, Uint8Array>()

  for (const [index, line] of lines.entries()) {
    if (!bytesOf.has(line))
      bytesOf.set(line, raw[index]!)
  }

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
    print(values.multi === true || values.filter !== undefined ? matching : matching.slice(0, 1), json, end, bytesOf)

    return 0
  }

  if (values['select-1'] === true && matching.length === 1) {
    print(matching, json, end, bytesOf)

    return 0
  }

  const rows = lines.map((line, index) => ({ hidden: [line], cells: [withNth === undefined ? line : pickFields(line, withNth, delimiter).trimEnd()], ...nth === undefined ? {} : { search: searched[index]! } }))
  const picked = await select(rows, { multi: values.multi === true, prompt: values.prompt ?? '> ', query, height, preview: values.preview, header: values.header })

  if (picked === undefined)
    return 130

  print(picked.rows.map(row => row.hidden[0]!), json, end, bytesOf)

  return 0
}

process.exitCode = await runMain({ name: 'pick', run: main })
