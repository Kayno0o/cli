#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Theme } from './theme'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, readInput, runMain, stripAnsi, wholeNumber } from '@kaynooo/cli-kit'
import { languageOf, renderCode } from './code'
import { looksLikeDiff, renderDiff } from './diff'
import { renderMarkdown } from './markdown'
import { themeFor } from './theme'

const DEFAULT_WIDTH = 80
const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i
const DIFF_FILE = /\.(?:diff|patch)$/i

const USAGE = `view [options] [file]: shows a markdown file, a source file or a git diff in the colours of the other @kaynooo CLIs

A file, or what is piped on stdin (or - for stdin). A source file (ts, js, json, yaml, toml, py, sh, css, sql, rs, go and more) is highlighted behind line numbers, by its extension or --lang. A diff, a \`git log -p\` or a \`git show\` is recognised by its first line or a .diff or .patch name, anything else is markdown; --diff and --markdown force one. Code blocks in markdown are highlighted by their language.
Lines wrap to the terminal width (80 when it is not a terminal) and a long output on a terminal goes through \`less -FRX\` unless --no-pager. No colour with NO_COLOR, a pipe or --plain.`
const EXITS: ExitRow[] = [[0, 'it showed the text'], [1, 'there is nothing to show'], [2, 'a usage error or a file that is missing']]

const OPTIONS = {
  diff: { type: 'boolean', description: 'show the text as a diff' },
  markdown: { type: 'boolean', description: 'show the text as markdown' },
  lang: { type: 'string', short: 'l', description: 'show the text as code in this language (ts, json, yaml, sh...)' },
  lines: { type: 'boolean', description: 'number the lines of code (--no-lines turns it off; on a terminal by default)' },
  width: { type: 'string', short: 'w', description: 'columns to wrap to, instead of the terminal\'s' },
  pager: { type: 'boolean', description: 'page a long output on a terminal (--no-pager turns it off)' },
  json: jsonOption('{kind: code, diff or markdown, language, text}, the text rendered without colour'),
} as const

// The text through the pager; a missing pager or one the reader quit leaves the text printed or dropped rather than failing.
async function page(text: string): Promise<void> {
  try {
    const pager = Bun.spawn(['less', '-FRX'], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })

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

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[file]'], allowNegative: true, replaces: 'cat, bat or less on a markdown file, delta on a diff', examples: ['view README.md', 'git diff | view'] })

  if (positionals.length > 1)
    badUsage('give one file')

  if (values.diff === true && values.markdown === true)
    badUsage('--diff and --markdown exclude each other')

  const path = positionals[0] ?? '-'
  const text = await readInput(path, { noStdin: 'give a file, or pipe the text on stdin' })

  if (text.trim() === '')
    fail('nothing to show', 1)

  const width = wholeNumber(values.width, 'width', process.stdout.isTTY === true ? process.stdout.columns || DEFAULT_WIDTH : DEFAULT_WIDTH, 20)
  const theme = themeFor(process.stdout)
  const language = values.lang === undefined ? languageOf(path) : languageOf(values.lang)

  if (values.lang !== undefined && language === undefined)
    badUsage(`unknown language ${values.lang}`)

  const forced = values.diff === true || values.markdown === true
  const isCode = values.lang !== undefined || (!forced && language !== undefined && !MARKDOWN_FILE.test(path) && !DIFF_FILE.test(path))
  const isDiff = !isCode && (values.diff === true || (values.markdown !== true && !MARKDOWN_FILE.test(path) && (DIFF_FILE.test(path) || looksLikeDiff(text))))
  const kind = isDiff ? 'diff' : 'markdown'

  function render(as: Theme, numbered: boolean): string {
    if (isCode)
      return renderCode(text, language, as, numbered)

    return isDiff ? renderDiff(text, as) : renderMarkdown(text, { theme: as, width })
  }

  if (values.json === true) {
    printJson({ kind: isCode ? 'code' : kind, language: isCode ? language ?? null : null, text: stripAnsi(render(themeFor({ isTTY: false }), values.lines ?? false)) })

    return 0
  }

  const shown = render(theme, values.lines ?? process.stdout.isTTY === true)

  if (process.stdout.isTTY === true && values.pager !== false && shown.split('\n').length > (process.stdout.rows || 24))
    await page(shown)
  else
    process.stdout.write(shown)

  return 0
}

process.exitCode = await runMain({ name: 'view', run: main })
