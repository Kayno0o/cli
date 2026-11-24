#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Name } from './code'
import type { Theme } from './theme'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { badUsage, canPage, fail, isHumanTerminal, jsonOption, parse, printJson, readInput, runMain, stripAnsi, wholeNumber } from '@kaynooo/cli-kit'
import { languageOf, renderCode } from './code'
import { looksLikeDiff, renderDiff } from './diff'
import { renderMarkdown } from './markdown'
import { themeFor } from './theme'

const DEFAULT_WIDTH = 80
const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i
const DIFF_FILE = /\.(?:diff|patch)$/i
const FILE_RANGE = /^(.+):(\d+)(?:-(\d*))?$/
const TRAILING_NEWLINE = /\n$/

const USAGE = `view [options] [file...]: shows markdown files, source files, plain text files or git diffs in the colours of the other @kaynooo CLIs

Files (each optionally with a line range such as src/a.ts:10-50), or what is piped on stdin (or - for stdin). A source file is highlighted behind line numbers by its extension or --lang, a diff, a \`git log -p\` or a \`git show\` is recognised by its first line or a .diff or .patch name, .md/.mdx/.markdown files (and stdin by default) are markdown, and unknown or .txt/.log files are shown as plain text preserving line breaks; --diff and --markdown force one.
Lines wrap to the terminal width and a long output on a terminal goes through $PAGER, unless --no-pager. No colour with NO_COLOR, a pipe or --plain. Control characters of the text, escape sequences included, show as cat -v writes them (^[) in code, text and diffs and are dropped from markdown, --json too.`
const EXITS: ExitRow[] = [[0, 'it showed the text'], [1, 'there is nothing to show'], [2, 'a usage error or a file that is missing']]

const OPTIONS = {
  diff: { type: 'boolean', description: 'show the text as a diff' },
  markdown: { type: 'boolean', description: 'show the text as markdown' },
  lang: { type: 'string', short: 'l', description: 'show the text as code in this language (ts, json, yaml, sh...)' },
  lines: { type: 'boolean', description: 'number the lines of code and text (--no-lines turns it off; on a terminal by default)' },
  width: { type: 'string', short: 'w', description: 'columns to wrap to, instead of the terminal\'s' },
  pager: { type: 'boolean', description: 'page a long output on a terminal (--no-pager turns it off)' },
  json: jsonOption('{kind: code, diff, markdown or text, language, text} (or an array for multiple files), rendered without colour'),
} as const

interface FileSpec {
  raw: string
  path: string
  start?: number
  end?: number
}

// Parses `path:10-50`, `path:10`, or `path:10-`, leaving a literal path containing `:` intact when that file exists.
function parseSpec(raw: string): FileSpec {
  if (raw === '-' || existsSync(raw))
    return { raw, path: raw }

  const match = FILE_RANGE.exec(raw)

  if (match === null)
    return { raw, path: raw }

  const start = Number(match[2])
  let end: number | undefined

  if (match[3] === undefined)
    end = start
  else if (match[3] !== '')
    end = Number(match[3])

  if (start < 1 || (end !== undefined && end < start))
    badUsage(`invalid line range in '${raw}'`)

  return { raw, path: match[1]!, start, ...end === undefined ? {} : { end } }
}

function sliceRange(text: string, start: number | undefined, end: number | undefined): { text: string, startLine: number } {
  if (start === undefined)
    return { text, startLine: 1 }

  const lines = text.replaceAll('\r\n', '\n').replace(TRAILING_NEWLINE, '').split('\n')
  const slice = lines.slice(start - 1, end)

  return { text: slice.length === 0 ? '' : `${slice.join('\n')}\n`, startLine: start }
}

// The width COLUMNS sets off a terminal, when it holds a usable one.
function columnsOf(variable: string | undefined): number {
  const columns = Number(variable)

  return Number.isInteger(columns) && columns >= 20 ? columns : DEFAULT_WIDTH
}

// $PAGER through the shell, except a bare less, which needs -R for the colours and -F to quit on a short text.
function pagerCommand(pager = process.env.PAGER): string[] {
  return pager === undefined || pager.trim() === '' || pager.trim() === 'less' ? ['less', '-FRX'] : ['sh', '-c', pager]
}

// The text through the pager; a missing pager or one the reader quit leaves the text printed or dropped rather than failing.
async function page(text: string): Promise<void> {
  try {
    const pager = Bun.spawn(pagerCommand(), { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })

    try {
      void pager.stdin.write(text)
      await pager.stdin.end()
    }
    catch {
      // The reader quit before the end.
    }

    await pager.exited
  }
  catch {
    process.stdout.write(text)
  }
}

type Kind = 'code' | 'diff' | 'markdown' | 'text'

function detectKind(path: string, text: string, language: Name | undefined, forced: { diff: boolean, markdown: boolean, lang: boolean }): Kind {
  if (forced.lang)
    return 'code'

  if (forced.diff)
    return 'diff'

  if (forced.markdown)
    return 'markdown'

  if (MARKDOWN_FILE.test(path))
    return 'markdown'

  if (DIFF_FILE.test(path) || looksLikeDiff(text))
    return 'diff'

  if (language !== undefined)
    return 'code'

  return path === '-' ? 'markdown' : 'text'
}

function renderKind(kind: Kind, text: string, language: Name | undefined, theme: Theme, numbered: boolean, width: number, startLine: number): string {
  if (kind === 'code')
    return renderCode(text, language, theme, numbered, startLine)

  if (kind === 'text')
    return renderCode(text, undefined, theme, numbered, startLine)

  return kind === 'diff' ? renderDiff(text, theme) : renderMarkdown(text, { theme, width })
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[file...]'], allowNegative: true, replaces: 'cat, bat or less on a markdown or source file, delta on a diff', examples: ['view README.md', 'view src/a.ts:10-40', 'view a.ts b.ts', 'git diff | view'] })

  if (values.diff === true && values.markdown === true)
    badUsage('--diff and --markdown exclude each other')

  const forcedLanguage = values.lang === undefined ? undefined : languageOf(values.lang)

  if (values.lang !== undefined && forcedLanguage === undefined)
    badUsage(`unknown language ${values.lang}`)

  const specs = (positionals.length === 0 ? ['-'] : positionals).map(parseSpec)
  const human = isHumanTerminal(process.stdout)
  const width = wholeNumber(values.width, 'width', human ? process.stdout.columns || DEFAULT_WIDTH : columnsOf(process.env.COLUMNS), 20)
  const theme = themeFor(process.stdout)
  const plainTheme = themeFor({ isTTY: false })
  const forced = { diff: values.diff === true, markdown: values.markdown === true, lang: values.lang !== undefined }
  const rendered: { spec: FileSpec, kind: Kind, language: Name | undefined, shown: string, plain: string }[] = []

  for (const spec of specs) {
    const raw = await readInput(spec.path, { noStdin: 'give a file, or pipe the text on stdin' })
    const { text, startLine } = sliceRange(raw, spec.start, spec.end)

    if (text.trim() === '')
      fail('nothing to show', 1)

    const language = forcedLanguage ?? (spec.path === '-' ? undefined : languageOf(spec.path))
    const kind = detectKind(spec.path, text, language, forced)
    const shown = renderKind(kind, text, language, theme, values.lines ?? human, width, startLine)
    const plain = stripAnsi(renderKind(kind, text, language, plainTheme, values.lines ?? false, width, startLine))

    rendered.push({ spec, kind, language, shown, plain })
  }

  if (values.json === true) {
    if (rendered.length === 1) {
      const [only] = rendered

      printJson({ kind: only!.kind, language: only!.kind === 'code' ? only!.language ?? null : null, text: only!.plain })
    }
    else {
      printJson(rendered.map(item => ({ path: item.spec.raw, kind: item.kind, language: item.kind === 'code' ? item.language ?? null : null, text: item.plain })))
    }

    return 0
  }

  const output = rendered.length === 1
    ? rendered[0]!.shown
    : rendered.map(item => `${theme.bold(theme.path(item.spec.raw))}\n${item.shown}`).join('\n')

  if (canPage(process.stdout) && values.pager !== false && output.split('\n').length > (process.stdout.rows || 24))
    await page(output)
  else
    process.stdout.write(output)

  return 0
}

process.exitCode = await runMain({ name: 'view', run: main })
