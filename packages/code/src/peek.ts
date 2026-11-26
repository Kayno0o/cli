import type { ExitRow } from '@kaynooo/cli-kit'
import type { Span } from './source'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { badUsage, capped, fail, isStdinPiped, jsonOption, limitOf, limitOptions, parse, printJson, runCommand, wholeNumber } from '@kaynooo/cli-kit'
import { counted } from '@kaynooo/utils/text'
import { listFiles, MAX_SIZE_OPTION, readText, unreadableReason, useMaxSize } from './files'
import { around, definitions, locations, outline, spansAround, usages } from './source'

const USAGE = `src peek [options] <file[:from-to]>...: prints files or line spans with their line numbers, several in one call

src peek src/a.ts:120-140 src/b.ts:1-40   the spans, src/a.ts:120 the one line, src/a.ts the whole file
src def <symbol> [path...]                 the whole declaration of the symbol (or src peek --def)
src refs <symbol> [path...]                the lines naming the symbol (or src peek --refs)
src outline <file>...                      the declarations and class members (or src peek --outline)
src around <regex> [-C 3] [path...]        the lines around each match (or src peek --around)
<output> | src peek [-C 3]                 the lines around each path:line the output opens a line with (errs, rg -n, grep -n, tsc, linters)
The paths default to the files git keeps here (\`.gitignore\` holds).`
const EXITS: ExitRow[] = [[0, 'it printed something'], [1, 'nothing is found, a file cannot be read or a span starts past the end'], [2, 'a usage error']]

const REFS_LIMIT = 100
const AROUND_LIMIT = 20

const OPTIONS = {
  'def': { type: 'string', short: 'd', multiple: true, description: 'print the declaration of this symbol, repeat for more' },
  'refs': { type: 'string', short: 'r', description: 'list the lines naming this symbol' },
  'outline': { type: 'boolean', short: 'o', description: 'list the declarations of the files given' },
  'around': { type: 'string', short: 'a', description: 'print the lines around the matches of this regular expression' },
  'defs-first': { type: 'boolean', description: 'with --refs, print the symbol\'s declarations before its lines' },
  'context': { type: 'string', short: 'C', description: 'lines on each side of an --around match or a piped location (3)' },
  ...limitOptions(REFS_LIMIT),
  ...MAX_SIZE_OPTION,
  'json': jsonOption('spans [{path, from, to, lines}], --refs [{path, line, text}] ({definitions, references} with --defs-first), --outline [{path, line, depth, text}]'),
} as const

const TARGET = /^(.+?):(\d+)(?:-(\d+))?$/
const LONGEST_LINE = 300
const TRAILING_NEWLINE = /\n$/

function cut(text: string): string {
  return text.length > LONGEST_LINE ? `${text.slice(0, LONGEST_LINE - 1)}…` : text
}

// The spans around the locations piped in, skipping unreadable files.
async function pipedSpans(text: string, context: number): Promise<Span[]> {
  const spans: Span[] = []

  for (const [path, numbers] of locations(text)) {
    const source = await readText(resolve(process.cwd(), path))

    if (source !== undefined)
      spans.push(...spansAround(path, source.replace(TRAILING_NEWLINE, '').split('\n').length, numbers, context))
  }

  return spans
}

async function textOf(path: string): Promise<string> {
  const text = await readText(resolve(process.cwd(), path))

  if (text === undefined)
    fail(`cannot read ${path} (${await unreadableReason(resolve(process.cwd(), path))})`, 1)

  return text
}

async function readSpans(spans: readonly Span[]): Promise<(Span & { lines: string[] })[]> {
  const texts = new Map<string, string[]>()
  const read: (Span & { lines: string[] })[] = []

  for (const span of spans) {
    const lines = texts.get(span.path) ?? (await textOf(span.path)).split('\n')

    texts.set(span.path, lines)
    read.push({ ...span, lines: lines.slice(span.from - 1, span.to) })
  }

  return read
}

function formatSpans(read: readonly (Span & { lines: string[] })[]): string {
  return read.map(span => [`${span.path}:${span.from}-${span.to}`, ...span.lines.map((line, i) => `${String(span.from + i).padStart(String(span.to).length)}  ${cut(line)}`)].join('\n')).join('\n\n')
}

// The spans printed under a `path:from-to` header each, the line numbers padded to the widest, or as JSON; `footer` counts the spans left out.
async function printSpans(spans: readonly Span[], json: boolean, footer?: string): Promise<void> {
  const read = await readSpans(spans)

  if (json) {
    printJson(read)

    return
  }

  console.log(formatSpans(read))

  if (footer !== undefined)
    console.log(footer)
}

// Rows under a header per file, the line numbers padded to the widest of the file.
function printByFile(rows: readonly { path: string, line: number, text: string }[]): void {
  const blocks = Map.groupBy(rows, row => row.path).entries().map(([path, ofPath]) => {
    const width = String(ofPath.at(-1)?.line ?? 0).length

    return [path, ...ofPath.map(row => `${String(row.line).padStart(width)}  ${row.text}`)].join('\n')
  })

  console.log([...blocks].join('\n\n'))
}

async function spanOf(target: string): Promise<Span> {
  const found = TARGET.exec(target)
  const path = found?.[1] ?? target
  const count = (await textOf(path)).replace(TRAILING_NEWLINE, '').split('\n').length
  const from = found === null ? 1 : Number(found[2])
  const to = found === null ? count : Number(found[3] ?? found[2])

  if (from < 1 || to < from)
    badUsage(`${target}: a span reads <file>:<from>-<to>, from 1 and from <= to`)

  if (from > count)
    fail(`${path} has ${counted(count, 'line')}, ${target} starts past the end`, 1)

  return { path, from, to: Math.min(to, count) }
}

// Pre-filters candidate files with `rg --files-with-matches` when available so symbol/regex searches skip non-matching files.
async function prefilterFiles(paths: readonly string[], filter?: { patterns: readonly string[], fixed?: boolean }): Promise<string[]> {
  const cwd = process.cwd()

  if (filter !== undefined && filter.patterns.length > 0 && Bun.which('rg') !== null) {
    const argv = ['rg', '--files-with-matches', '--color=never', '--no-messages', ...(filter.fixed === true ? ['-F'] : [])]

    for (const pattern of filter.patterns)
      argv.push('-e', pattern)

    argv.push('--', ...(paths.length === 0 ? ['.'] : paths))

    const ran = await runCommand(argv, { cwd })

    if (ran.code === 0 || ran.code === 1) {
      return ran.stdout
        .split('\n')
        .filter(Boolean)
        .map((file) => {
          if (file.startsWith('./'))
            return file.slice(2)

          return file.startsWith('/') ? relative(cwd, file) : file
        })
        .sort()
    }
  }

  return listFiles(paths, cwd)
}

// Each readable file under the paths, with its text, optionally pre-filtered with rg.
async function* sources(paths: readonly string[], filter?: { patterns: readonly string[], fixed?: boolean }): AsyncGenerator<{ path: string, text: string }> {
  const cwd = process.cwd()

  for (const path of await prefilterFiles(paths, filter)) {
    const text = await readText(join(cwd, path))

    if (text !== undefined)
      yield { path, text }
  }
}

function regex(source: string): RegExp {
  try {
    return new RegExp(source)
  }
  catch (error) {
    return badUsage(`--around is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The declarations of each symbol in turn, exiting 1 naming the symbols with none.
async function definitionsOf(symbols: readonly string[], paths: readonly string[]): Promise<Span[]> {
  const found = new Map<string, Span[]>(symbols.map(symbol => [symbol, []]))

  for await (const { path, text } of sources(paths, { patterns: symbols, fixed: true })) {
    for (const symbol of symbols)
      found.get(symbol)?.push(...definitions(text, path, symbol))
  }

  const missing = symbols.filter(symbol => found.get(symbol)?.length === 0)

  if (missing.length > 0)
    fail(`no declaration of ${missing.join(', ')} found`, 1)

  return [...found.values()].flat()
}

export async function peek(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[target...]'], replaces: 'sed -n N,Mp, grep -n chains and whole-file reads', examples: [['src peek src/a.ts:120-140 src/b.ts:1-40', 'two spans in one call'], ['src def parseArgs src', 'a whole declaration']] })
  const modes = [values.def?.length === 0 ? undefined : values.def, values.refs, values.outline, values.around].filter(mode => mode !== undefined && mode !== false)
  const json = values.json === true

  useMaxSize(values['max-size'])

  if (values['defs-first'] === true && values.refs === undefined)
    badUsage('--defs-first goes with --refs')

  if (modes.length > 1)
    badUsage('give one of --def, --refs, --outline and --around')

  const isPiped = modes.length === 0 && positionals.length === 0 && isStdinPiped()

  if (values.context !== undefined && values.around === undefined && !isPiped)
    badUsage('-C goes with --around or with locations piped in')

  if (isPiped) {
    const spans = await pipedSpans(await Bun.stdin.text(), wholeNumber(values.context, 'context', 3, 0))

    if (spans.length === 0)
      fail('no path:line of a readable file in what was piped in', 1)

    await printSpans(spans, json)

    return 0
  }

  if (values.def !== undefined && values.def.length > 0) {
    const spans = await definitionsOf(values.def, positionals)

    await printSpans(spans, json)

    return 0
  }

  if (values.refs !== undefined) {
    const rows: { path: string, line: number, text: string }[] = []

    for await (const { path, text } of sources(positionals, { patterns: [values.refs], fixed: true })) {
      const lines = text.split('\n')

      rows.push(...usages(text, values.refs, path).map(line => ({ path, line, text: (lines[line - 1] ?? '').trim() })))
    }

    if (rows.length === 0)
      fail(`nothing names ${values.refs}`, 1)

    const { shown, footer } = capped(rows, limitOf({ ...values, json }, REFS_LIMIT))
    const defs = values['defs-first'] === true ? await readSpans(await definitionsOf([values.refs], positionals)) : []

    if (json) {
      printJson(values['defs-first'] === true ? { definitions: defs, references: shown } : shown)
    }
    else {
      if (defs.length > 0)
        console.log(`${formatSpans(defs)}\n`)

      printByFile(shown.map(row => ({ ...row, text: cut(row.text) })))

      if (footer !== undefined)
        console.log(footer)
    }

    return 0
  }

  if (values.outline === true) {
    if (positionals.length === 0)
      badUsage('give the files to outline')

    const rows: { path: string, line: number, depth: number, text: string }[] = []

    for (const path of positionals)
      rows.push(...outline(await textOf(path), path).map(entry => ({ path, ...entry })))

    if (json)
      printJson(rows)
    else
      printByFile(rows.map(row => ({ ...row, text: `${'  '.repeat(row.depth)}${row.text}` })))

    return 0
  }

  if (values.around !== undefined) {
    const pattern = regex(values.around)
    const context = wholeNumber(values.context, 'context', 3, 0)
    const spans: Span[] = []

    for await (const { path, text } of sources(positionals, { patterns: [values.around], fixed: false }))
      spans.push(...around(text, path, pattern, context))

    if (spans.length === 0)
      fail(`no line matches ${values.around}`, 1)

    const { shown, footer } = capped(spans, limitOf({ ...values, json }, AROUND_LIMIT))

    await printSpans(shown, json, footer)

    return 0
  }

  if (positionals.length === 0)
    badUsage('give the files or spans to print')

  await printSpans(await Promise.all(positionals.map(spanOf)), json)

  return 0
}

const DEF_USAGE = 'src def <symbol> [path...]: prints the whole declaration of a symbol (comments included)'
const REFS_USAGE = 'src refs <symbol> [path...]: lists every line naming a symbol outside strings and comments'
const OUTLINE_USAGE = 'src outline <file>...: lists top-level declarations (including arrow functions), class members, and Markdown headings'
const AROUND_USAGE = 'src around <regex> [-C 3] [path...]: prints lines around each regex match, merging overlaps'

export async function defCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, DEF_USAGE, {
    def: { type: 'string', short: 'd', multiple: true, description: 'additional symbol to look up, repeatable' },
    ...MAX_SIZE_OPTION,
    json: jsonOption('[{path, from, to, lines}]'),
  }, { exits: EXITS, positionals: ['<symbol>', '[path...]'], examples: [['src def parseArgs packages/kit/src', 'find parseArgs declaration']] })

  useMaxSize(values['max-size'])

  const [symbol, ...paths] = positionals
  const symbols = [symbol, ...(values.def ?? [])]

  await printSpans(await definitionsOf(symbols, paths), values.json === true)

  return 0
}

export async function refsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, REFS_USAGE, {
    'defs-first': { type: 'boolean', description: 'print the symbol\'s declarations before its references' },
    ...limitOptions(REFS_LIMIT),
    ...MAX_SIZE_OPTION,
    'json': jsonOption('[{path, line, text}] ({definitions, references} with --defs-first)'),
  }, { exits: EXITS, positionals: ['<symbol>', '[path...]'], examples: [['src refs parseArgs --defs-first', 'declarations followed by every reference']] })

  useMaxSize(values['max-size'])

  const [symbol, ...paths] = positionals
  const json = values.json === true
  const rows: { path: string, line: number, text: string }[] = []

  for await (const { path, text } of sources(paths, { patterns: [symbol], fixed: true })) {
    const lines = text.split('\n')

    rows.push(...usages(text, symbol, path).map(line => ({ path, line, text: (lines[line - 1] ?? '').trim() })))
  }

  if (rows.length === 0)
    fail(`nothing names ${symbol}`, 1)

  const { shown, footer } = capped(rows, limitOf({ ...values, json }, REFS_LIMIT))
  const defs = values['defs-first'] === true ? await readSpans(await definitionsOf([symbol], paths)) : []

  if (json) {
    printJson(values['defs-first'] === true ? { definitions: defs, references: shown } : shown)
  }
  else {
    if (defs.length > 0)
      console.log(`${formatSpans(defs)}\n`)

    printByFile(shown.map(row => ({ ...row, text: cut(row.text) })))

    if (footer !== undefined)
      console.log(footer)
  }

  return 0
}

export async function outlineCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, OUTLINE_USAGE, {
    ...MAX_SIZE_OPTION,
    json: jsonOption('[{path, line, depth, text}]'),
  }, { exits: EXITS, positionals: ['<file>...'], examples: [['src outline packages/code/src/source.ts', 'declarations and class members']] })

  useMaxSize(values['max-size'])
  const rows: { path: string, line: number, depth: number, text: string }[] = []

  for (const path of positionals)
    rows.push(...outline(await textOf(path), path).map(entry => ({ path, ...entry })))

  if (values.json === true)
    printJson(rows)
  else
    printByFile(rows.map(row => ({ ...row, text: `${'  '.repeat(row.depth)}${row.text}` })))

  return 0
}

export async function aroundCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, AROUND_USAGE, {
    context: { type: 'string', short: 'C', description: 'lines on each side of each match (3)' },
    ...limitOptions(AROUND_LIMIT),
    ...MAX_SIZE_OPTION,
    json: jsonOption('[{path, from, to, lines}]'),
  }, { exits: EXITS, positionals: ['<regex>', '[path...]'], examples: [['src around "TODO|FIXME" -C 2 src', 'lines around each match']] })

  useMaxSize(values['max-size'])

  const [rawPattern, ...paths] = positionals
  const pattern = regex(rawPattern)
  const context = wholeNumber(values.context, 'context', 3, 0)
  const json = values.json === true
  const spans: Span[] = []

  for await (const { path, text } of sources(paths, { patterns: [rawPattern], fixed: false }))
    spans.push(...around(text, path, pattern, context))

  if (spans.length === 0)
    fail(`no line matches ${rawPattern}`, 1)

  const { shown, footer } = capped(spans, limitOf({ ...values, json }, AROUND_LIMIT))

  await printSpans(shown, json, footer)

  return 0
}
