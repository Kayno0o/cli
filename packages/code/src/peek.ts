#!/usr/bin/env bun

import type { Span } from './source'
import { join } from 'node:path'
import process from 'node:process'
import { badUsage, fail, parse, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { listFiles, readText } from './files'
import { around, definitions, outline, usages } from './source'

const USAGE = `peek [options] <file[:from-to]>...: prints files or line spans with their line numbers, several in one call

peek src/a.ts:120-140 src/b.ts:1-40   the spans, src/a.ts:120 the one line, src/a.ts the whole file
peek --def <symbol> [path...]          the whole declaration of the symbol, its comments included
peek --refs <symbol> [path...]         the lines naming the symbol, grouped by file
peek --outline <file>...               the declarations and class members, a Markdown file's headings
peek --around <regex> [-C 3] [path...] the lines around each match, overlapping ones merged
The paths default to the files git keeps here (.gitignore holds). Exits 1 when nothing is found.`

const OPTIONS = {
  def: { type: 'string', short: 'd', description: 'print the declaration of this symbol' },
  refs: { type: 'string', short: 'r', description: 'list the lines naming this symbol' },
  outline: { type: 'boolean', short: 'o', description: 'list the declarations of the files given' },
  around: { type: 'string', short: 'a', description: 'print the lines around the matches of this regular expression' },
  context: { type: 'string', short: 'C', description: 'lines on each side of an --around match (3)' },
} as const

const TARGET = /^(.+?):(\d+)(?:-(\d+))?$/
const LONGEST_LINE = 300
const TRAILING_NEWLINE = /\n$/

function cut(text: string): string {
  return text.length > LONGEST_LINE ? `${text.slice(0, LONGEST_LINE - 1)}…` : text
}

async function textOf(path: string): Promise<string> {
  const text = await readText(join(process.cwd(), path))

  if (text === undefined)
    fail(`cannot read ${path} (missing, binary or too large)`, 1)

  return text
}

// The spans printed under a `path:from-to` header each, the line numbers padded to the widest.
async function printSpans(spans: readonly Span[]): Promise<void> {
  const texts = new Map<string, string[]>()
  const blocks: string[] = []

  for (const span of spans) {
    const lines = texts.get(span.path) ?? (await textOf(span.path)).split('\n')
    const width = String(span.to).length

    texts.set(span.path, lines)
    blocks.push([`${span.path}:${span.from}-${span.to}`, ...lines.slice(span.from - 1, span.to).map((line, i) => `${String(span.from + i).padStart(width)}  ${cut(line)}`)].join('\n'))
  }

  console.log(blocks.join('\n\n'))
}

async function spanOf(target: string): Promise<Span> {
  const found = TARGET.exec(target)
  const path = found?.[1] ?? target
  const count = (await textOf(path)).replace(TRAILING_NEWLINE, '').split('\n').length
  const from = found === null ? 1 : Number(found[2])
  const to = found === null ? count : Number(found[3] ?? found[2])

  if (from < 1 || to < from)
    badUsage(`${target}: a span reads <file>:<from>-<to>, from 1 and from <= to`)

  return { path, from, to: Math.min(to, count) }
}

// Each readable file under the paths, with its text.
async function* sources(paths: readonly string[]): AsyncGenerator<{ path: string, text: string }> {
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

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[target...]'] })
  const modes = [values.def, values.refs, values.outline, values.around].filter(mode => mode !== undefined && mode !== false)

  if (modes.length > 1)
    badUsage('give one of --def, --refs, --outline and --around')

  if (values.context !== undefined && values.around === undefined)
    badUsage('-C goes with --around')

  if (values.def !== undefined) {
    const spans: Span[] = []

    for await (const { path, text } of sources(positionals))
      spans.push(...definitions(text, path, values.def))

    if (spans.length === 0)
      fail(`no declaration of ${values.def} found`, 1)

    await printSpans(spans)

    return 0
  }

  if (values.refs !== undefined) {
    const blocks: string[] = []

    for await (const { path, text } of sources(positionals)) {
      const lines = text.split('\n')
      const found = usages(text, values.refs)
      const width = String(found.at(-1) ?? 0).length

      if (found.length > 0)
        blocks.push([path, ...found.map(line => `${String(line).padStart(width)}  ${cut((lines[line - 1] ?? '').trim())}`)].join('\n'))
    }

    if (blocks.length === 0)
      fail(`nothing names ${values.refs}`, 1)

    console.log(blocks.join('\n\n'))

    return 0
  }

  if (values.outline === true) {
    if (positionals.length === 0)
      badUsage('give the files to outline')

    const blocks: string[] = []

    for (const path of positionals) {
      const entries = outline(await textOf(path), path)
      const width = String(entries.at(-1)?.line ?? 0).length

      blocks.push([path, ...entries.map(entry => `${String(entry.line).padStart(width)}  ${'  '.repeat(entry.depth)}${entry.text}`)].join('\n'))
    }

    console.log(blocks.join('\n\n'))

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

    await printSpans(spans)

    return 0
  }

  if (positionals.length === 0)
    badUsage('give the files or spans to print')

  await printSpans(await Promise.all(positionals.map(spanOf)))

  return 0
}

process.exitCode = await runMain({ name: 'peek', version, run: main })
