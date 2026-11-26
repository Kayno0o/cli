#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Row } from '@kaynooo/cli-kit/picker'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { DEFAULT_HEIGHT, parseHeight, parsePreviewWindow, rank, select } from '@kaynooo/cli-kit/picker'
import { parseFields, pickFields } from './fields'

const USAGE = `pick [options] [file]: a fuzzy selector, the lines of a file or of stdin in, the chosen one on stdout out

Type to filter: the query matches as a subsequence, best matches first, and ctrl-/ or f1 shows the keys; enter picks, esc and ctrl-c cancel.
The keys are read from the terminal and the selector is drawn on stderr, so \`pick\` in a pipe or a command substitution prints only the choice. In interactive mode stdin streams in incrementally so large or slow pipes become usable immediately. With --multi, tab marks lines and enter prints them in input order.
--delimiter, --nth and --with-nth split lines into fields in fzf's syntax, and the printed line is always the whole input line.
Without a terminal on stderr it prints the best match, or every match with --multi.`
const EXITS: ExitRow[] = [[0, 'it printed a choice'], [1, 'nothing matches or there are no lines'], [2, 'a usage error'], [130, 'cancelled']]

const OPTIONS = {
  'multi': { type: 'boolean', short: 'm', description: 'tab marks several lines, enter prints them' },
  'prompt': { type: 'string', short: 'p', description: 'the prompt before the query (> )' },
  // -q is the query here, not quiet: it predates the convention and pick has nothing to silence.
  'query': { type: 'string', short: 'q', description: 'the query to start with' },
  'preview': { type: 'string', description: 'a command shown for the highlighted line, {} standing for it' },
  'preview-window': { type: 'string', description: 'preview placement and size: right, bottom, hidden, optionally :<N>% (e.g. bottom:40%)' },
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

// The chosen lines, given by index, as JSON, or each as the bytes it came in (a name that is not UTF-8 kept as it is) followed by `end`.
function print(chosen: number[], lines: string[], raw: Uint8Array[], json: boolean, end: string): void {
  if (json)
    printJson({ picked: chosen.map(index => lines[index]!) })
  else
    process.stdout.write(Buffer.concat(chosen.flatMap(index => [raw[index]!, Buffer.from(end)])))
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

function buildRow(line: string, nth: ((count: number) => number[]) | undefined, withNth: ((count: number) => number[]) | undefined, delimiter: RegExp | undefined): Row {
  const display = withNth === undefined ? line : pickFields(line, withNth, delimiter).trimEnd()
  const search = nth === undefined ? undefined : pickFields(line, nth, delimiter)

  return { hidden: [line], cells: [display], ...search === undefined ? {} : { search } }
}

async function* streamRows(
  input: Bun.BunFile,
  separator: number,
  nth: ((count: number) => number[]) | undefined,
  withNth: ((count: number) => number[]) | undefined,
  delimiter: RegExp | undefined,
  sink: { raw: Uint8Array[], lines: string[], rows: Row[] },
): AsyncGenerator<Row[]> {
  const decoder = new TextDecoder()
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

  for await (const chunk of input.stream()) {
    const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
    const batch: Row[] = []
    let start = 0

    for (let at = combined.indexOf(separator); at !== -1; at = combined.indexOf(separator, start)) {
      const part = combined.subarray(start, at)

      if (part.length > 0) {
        const bytes = new Uint8Array(part)
        const line = decoder.decode(bytes)
        const row = buildRow(line, nth, withNth, delimiter)

        sink.raw.push(bytes)
        sink.lines.push(line)
        sink.rows.push(row)
        batch.push(row)
      }

      start = at + 1
    }

    carry = combined.subarray(start)

    if (batch.length > 0)
      yield batch
  }

  if (carry.length > 0) {
    const bytes = new Uint8Array(carry)
    const line = decoder.decode(bytes)
    const row = buildRow(line, nth, withNth, delimiter)

    sink.raw.push(bytes)
    sink.lines.push(line)
    sink.rows.push(row)
    yield [row]
  }
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[file]'], replaces: 'fzf for a quick choice in a pipe, select in a shell script', examples: ['git branch --format=\'%(refname:short)\' | pick', 'ls | pick --multi --preview \'head -20 {}\' --preview-window bottom:40%', 'git branch | pick --filter main  # every match, best first, no terminal', 'ps aux | pick --with-nth 2,11.. --nth 11..  # show some fields, search others'] })

  const [file] = positionals

  if (file !== undefined && !await Bun.file(file).exists())
    fail(`${file}: no such file`, 2)

  const input = file === undefined ? Bun.stdin : Bun.file(file)

  const height = values.height === undefined ? DEFAULT_HEIGHT : parseHeight(values.height)

  if (height === undefined)
    badUsage(`--height takes a number of lines or a percentage such as 40%, not ${values.height}`)

  const previewWindow = values['preview-window'] === undefined ? undefined : parsePreviewWindow(values['preview-window'])

  if (values['preview-window'] !== undefined && previewWindow === undefined)
    badUsage(`--preview-window takes right, bottom, hidden (optionally :<10-90>%), not ${values['preview-window']}`)

  if (file === undefined && process.stdin.isTTY)
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

  const separator = values.read0 === true ? 0 : 10
  const query = values.filter ?? values.query ?? ''
  const end = values.print0 === true ? '\0' : '\n'
  const json = values.json === true
  const interactive = process.stderr.isTTY && values.filter === undefined && values['select-1'] !== true && values['exit-0'] !== true

  if (interactive) {
    const sink: { raw: Uint8Array[], lines: string[], rows: Row[] } = { raw: [], lines: [], rows: [] }
    const picked = await select([], {
      multi: values.multi === true,
      prompt: values.prompt ?? '> ',
      query,
      height,
      preview: values.preview,
      previewPosition: previewWindow?.position,
      previewShare: previewWindow?.share,
      header: values.header,
      stream: streamRows(input, separator, nth, withNth, delimiter, sink),
    })

    if (picked === undefined)
      return sink.lines.length === 0 ? 1 : 130

    print(picked.rows.map(row => sink.rows.indexOf(row)), sink.lines, sink.raw, json, end)

    return 0
  }

  // Lines are matched as text and printed as the bytes they came in.
  const raw = splitBytes(await input.bytes(), separator)
  const decoder = new TextDecoder()
  const lines = raw.map(bytes => decoder.decode(bytes))

  if (lines.length === 0)
    fail('nothing to pick from', 1)

  const searched = lines.map(line => nth === undefined ? line : pickFields(line, nth, delimiter))
  const matching = rank(query, searched).map(({ index }) => index)

  if (matching.length === 0 && (values['exit-0'] === true || values.filter !== undefined || !process.stderr.isTTY))
    return 1

  // Nobody to choose, so the lines the query matches are the choice: all of them with --multi or --filter, else the first.
  if (values.filter !== undefined || !process.stderr.isTTY) {
    print(values.multi === true || values.filter !== undefined ? matching : matching.slice(0, 1), lines, raw, json, end)

    return 0
  }

  if (values['select-1'] === true && matching.length === 1) {
    print(matching, lines, raw, json, end)

    return 0
  }

  const rows = lines.map((line, index) => ({ hidden: [line], cells: [withNth === undefined ? line : pickFields(line, withNth, delimiter).trimEnd()], ...nth === undefined ? {} : { search: searched[index]! } }))
  const picked = await select(rows, { multi: values.multi === true, prompt: values.prompt ?? '> ', query, height, preview: values.preview, previewPosition: previewWindow?.position, previewShare: previewWindow?.share, header: values.header })

  if (picked === undefined)
    return 130

  print(picked.rows.map(row => rows.indexOf(row)), lines, raw, json, end)

  return 0
}

process.exitCode = await runMain({ name: 'pick', run: main })
