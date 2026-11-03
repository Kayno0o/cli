#!/usr/bin/env bun

import process from 'node:process'
import { badUsage, fail, parse, readInput, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { looksLikeDiff, renderDiff } from './diff'
import { renderMarkdown } from './markdown'
import { themeFor } from './theme'

const DEFAULT_WIDTH = 80
const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i
const DIFF_FILE = /\.(?:diff|patch)$/i

const USAGE = `view [options] [file]: shows a markdown file or a git diff in the colours of the other @kaynooo CLIs

A file, or what is piped on stdin (or - for stdin). A diff, a \`git log -p\` or a \`git show\` is recognised by its first line or a .diff or .patch name, anything else is markdown; --diff and --markdown force one.
Lines wrap to the terminal width (80 when it is not a terminal) and a long output on a terminal goes through \`less -FRX\` unless --no-pager. No colour with NO_COLOR, a pipe or --plain.

Exits 0 when it showed the text, 1 when there is nothing to show, 2 on a usage error or a file that is missing.`

const OPTIONS = {
  diff: { type: 'boolean', description: 'show the text as a diff' },
  markdown: { type: 'boolean', description: 'show the text as markdown' },
  width: { type: 'string', short: 'w', description: 'columns to wrap to, instead of the terminal\'s' },
  pager: { type: 'boolean', description: 'page a long output on a terminal (--no-pager turns it off)' },
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
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[file]'], allowNegative: true, replaces: 'cat, bat or less on a markdown file, delta on a diff', examples: ['view README.md', 'git diff | view'] })

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
  const isDiff = values.diff === true || (values.markdown !== true && !MARKDOWN_FILE.test(path) && (DIFF_FILE.test(path) || looksLikeDiff(text)))
  const shown = isDiff ? renderDiff(text, theme) : renderMarkdown(text, { theme, width })

  if (process.stdout.isTTY === true && values.pager !== false && shown.split('\n').length > (process.stdout.rows || 24))
    await page(shown)
  else
    process.stdout.write(shown)

  return 0
}

process.exitCode = await runMain({ name: 'view', version, run: main })
