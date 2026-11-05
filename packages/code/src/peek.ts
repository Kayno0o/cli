import type { Span } from './source'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { badUsage, capped, fail, isStdinPiped, jsonOption, limitOf, limitOptions, parse, printJson, runCommand, wholeNumber } from '@kaynooo/cli-kit'
import { counted } from '@kaynooo/utils'
import { listFiles, readText } from './files'
import { around, definitions, locations, outline, spansAround, usages } from './source'

const USAGE = `peek [options] <file[:from-to]>...: prints files or line spans with their line numbers, several in one call

peek src/a.ts:120-140 src/b.ts:1-40   the spans, src/a.ts:120 the one line, src/a.ts the whole file
peek --def <symbol> [path...]          the whole declaration of the symbol, its comments included, --def again for more symbols
peek --refs <symbol> [path...]         the lines naming the symbol, grouped by file, --defs-first printing its declarations before
peek --outline <file>...               the declarations and class members, a Markdown file's headings
peek --around <regex> [-C 3] [path...] the lines around each match, overlapping ones merged
<output> | peek [-C 3]                 the lines around each path:line the output opens a line with (errs, rg -n, grep -n, tsc, linters)
The paths default to the files git keeps here (.gitignore holds).
--refs lists at most 100 lines and --around prints at most 20 spans, the count of the rest after them (--limit <n>, --full for all).
--json prints spans as [{path, from, to, lines}], --refs as [{path, line, text}] ({definitions, references} with --defs-first), --outline as [{path, line, depth, text}], the lines never cut and the rows never counted off unless --limit is given.

Exits 0 when it printed something, 1 when nothing is found, a file cannot be read or a span starts past the end, 2 on a usage error or a path outside the repository.`

const REFS_LIMIT = 100
const AROUND_LIMIT = 20
const PARENT = `..${sep}`

const OPTIONS = {
  'def': { type: 'string', short: 'd', multiple: true, description: 'print the declaration of this symbol, repeat for more' },
  'refs': { type: 'string', short: 'r', description: 'list the lines naming this symbol' },
  'outline': { type: 'boolean', short: 'o', description: 'list the declarations of the files given' },
  'around': { type: 'string', short: 'a', description: 'print the lines around the matches of this regular expression' },
  'defs-first': { type: 'boolean', description: 'with --refs, print the symbol\'s declarations before its lines' },
  'context': { type: 'string', short: 'C', description: 'lines on each side of an --around match or a piped location (3)' },
  ...limitOptions(REFS_LIMIT),
  'json': jsonOption(),
} as const

const TARGET = /^(.+?):(\d+)(?:-(\d+))?$/
const LONGEST_LINE = 300
const TRAILING_NEWLINE = /\n$/

function cut(text: string): string {
  return text.length > LONGEST_LINE ? `${text.slice(0, LONGEST_LINE - 1)}…` : text
}

// The repository's top folder, or the current one outside git: nothing past it is read.
async function readableRoot(): Promise<string> {
  const ran = await runCommand(['git', 'rev-parse', '--show-toplevel'], { cwd: process.cwd() })

  return realpathSync(ran.code === 0 ? ran.text.trim() : process.cwd())
}

// Whether a path's real location, a symlink followed, lies outside the repository; a path that does not exist is not.
async function isOutside(path: string): Promise<boolean> {
  let real

  try {
    real = realpathSync(resolve(process.cwd(), path))
  }
  catch {
    return false
  }

  const inRoot = relative(await readableRoot(), real)

  return inRoot === '..' || inRoot.startsWith(PARENT) || isAbsolute(inRoot)
}

// Refuses a path outside the repository, so peek reads no more than a grep of the repository would.
async function checkInside(path: string): Promise<void> {
  if (await isOutside(path))
    badUsage(`${path} is outside the repository`)
}

// The spans around the locations piped in, a path outside the repository or not readable left out.
async function pipedSpans(text: string, context: number): Promise<Span[]> {
  const spans: Span[] = []

  for (const [path, numbers] of locations(text)) {
    const source = await isOutside(path) ? undefined : await readText(resolve(process.cwd(), path))

    if (source !== undefined)
      spans.push(...spansAround(path, source.replace(TRAILING_NEWLINE, '').split('\n').length, numbers, context))
  }

  return spans
}

async function textOf(path: string): Promise<string> {
  await checkInside(path)

  const text = await readText(resolve(process.cwd(), path))

  if (text === undefined)
    fail(`cannot read ${path} (missing, binary or too large)`, 1)

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

// Each readable file under the paths, with its text.
async function* sources(paths: readonly string[]): AsyncGenerator<{ path: string, text: string }> {
  for (const path of paths)
    await checkInside(path)

  for (const path of await listFiles(paths, process.cwd())) {
    const text = await readText(join(process.cwd(), path))

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

  for await (const { path, text } of sources(paths)) {
    for (const symbol of symbols)
      found.get(symbol)?.push(...definitions(text, path, symbol))
  }

  const missing = symbols.filter(symbol => found.get(symbol)?.length === 0)

  if (missing.length > 0)
    fail(`no declaration of ${missing.join(', ')} found`, 1)

  return [...found.values()].flat()
}

export async function peek(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[target...]'], replaces: 'sed -n N,Mp, grep -n chains and whole-file reads', examples: [['peek src/a.ts:120-140 src/b.ts:1-40', 'two spans in one call'], ['peek --def parseArgs src', 'a whole declaration']] })
  const modes = [values.def?.length === 0 ? undefined : values.def, values.refs, values.outline, values.around].filter(mode => mode !== undefined && mode !== false)
  const json = values.json === true

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

    for await (const { path, text } of sources(positionals)) {
      const lines = text.split('\n')

      rows.push(...usages(text, values.refs).map(line => ({ path, line, text: (lines[line - 1] ?? '').trim() })))
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

    for await (const { path, text } of sources(positionals))
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
