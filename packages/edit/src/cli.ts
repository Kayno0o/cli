#!/usr/bin/env bun

import type { Pair } from './replace'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { Exit, fail, parse, readInput, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { diffTexts } from './diff'
import { applyPairs, compile, listLines } from './replace'

const USAGE = 'sub [options] <file>...: replaces text in files, writing nothing unless every replacement matches as often as expected\n\nExits 0 when it wrote every replacement, 1 when one did not match or a file cannot be written (nothing is written), 2 on a usage error.'

const OPTIONS = {
  'from': { type: 'string', short: 'f', description: 'text to find, taken literally' },
  'to': { type: 'string', short: 't', description: 'text to put in its place, empty to delete it' },
  'count': { type: 'string', short: 'n', description: 'matches expected in each file (default 1)' },
  'all': { type: 'boolean', short: 'a', description: 'replace every match, expecting at least one in each file' },
  'regex': { type: 'boolean', short: 'r', description: '--from is a regular expression (^ and $ match each line), --to may use $1 and $<name>' },
  'pairs': { type: 'string', short: 'p', description: 'JSON array of {from, to, count?, all?, regex?} applied in order, from a file or - for stdin' },
  'diff': { type: 'boolean', short: 'd', description: 'print each file\'s unified diff' },
  'dry-run': { type: 'boolean', description: 'show what would change without writing' },
} as const

interface Defaults {
  count: number | undefined
  all: boolean
  regex: boolean
}

function checkPattern(pair: Pair, label: string) {
  if (pair.from === '')
    fail(`${label}--from is empty`)

  if (pair.regex !== true)
    return

  try {
    compile(pair.from)
  }
  catch (error) {
    fail(`${label}--from is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function pairFrom(item: unknown, i: number, defaults: Defaults): Pair {
  const label = `pair ${i + 1}: `

  if (typeof item !== 'object' || item === null || Array.isArray(item))
    fail(`${label}give an object {from, to}`)

  const { from, to, count, all, regex } = item as Record<string, unknown>

  if (typeof from !== 'string' || typeof to !== 'string')
    fail(`${label}from and to must both be strings`)

  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1))
    fail(`${label}count takes a whole number from 1`)

  if ((all !== undefined && typeof all !== 'boolean') || (regex !== undefined && typeof regex !== 'boolean'))
    fail(`${label}all and regex take true or false`)

  const pair: Pair = { from, to, count: count ?? defaults.count ?? 1, all: all ?? defaults.all, regex: regex ?? defaults.regex }

  checkPattern(pair, label)

  return pair
}

async function readPairs(path: string, defaults: Defaults): Promise<Pair[]> {
  let items: unknown

  try {
    items = JSON.parse(await readInput(path, { noStdin: 'pipe the pairs on stdin, or give their file to --pairs' }))
  }
  catch (error) {
    if (error instanceof Exit)
      throw error

    fail(`--pairs is no valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!Array.isArray(items) || items.length === 0)
    fail('--pairs takes a JSON array of at least one {from, to}')

  return items.map((item, i) => pairFrom(item, i, defaults))
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)

    return true
  }
  catch {
    return false
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS)

  const { values, positionals } = parsed
  const files = [...new Set(positionals)]

  if (files.length === 0)
    fail(`give at least one file\n\n${USAGE}`)

  if (values.count !== undefined && values.all === true)
    fail('--count and --all exclude each other')

  const defaults: Defaults = { count: values.count === undefined ? undefined : wholeNumber(values.count, 'count', 1), all: values.all === true, regex: values.regex === true }
  let pairs: Pair[]

  if (values.pairs !== undefined) {
    if (values.from !== undefined || values.to !== undefined)
      fail('give either --pairs or --from and --to')

    pairs = await readPairs(values.pairs, defaults)
  }
  else {
    if (values.from === undefined || values.to === undefined)
      fail(`give --from and --to (--to '' deletes), or --pairs\n\n${USAGE}`)

    pairs = [{ from: values.from, to: values.to, count: defaults.count ?? 1, all: defaults.all, regex: defaults.regex }]
    checkPattern(pairs[0] as Pair, '')
  }

  const changes: { path: string, before: string, after: string, lines: number[] }[] = []
  const problems: string[] = []

  for (const path of files) {
    if (!existsSync(path)) {
      problems.push(`${path}: no such file`)

      continue
    }

    const before = readFileSync(path, 'utf8')
    const applied = applyPairs(before, pairs)

    problems.push(...applied.problems.map(problem => `${path}: ${problem}`))

    if (applied.problems.length === 0 && values['dry-run'] !== true && !writable(path))
      problems.push(`${path}: not writable`)

    changes.push({ path, before, after: applied.text, lines: applied.lines })
  }

  if (problems.length > 0) {
    console.error(`sub: nothing written\n${problems.join('\n')}`)

    return 1
  }

  for (const { path, before, after, lines } of changes) {
    const diff = await diffTexts(path, before, after)

    if (values['dry-run'] !== true && after !== before)
      writeFileSync(path, after)

    console.log(`${path}: ${plural(lines.length, 'replacement')} on line${lines.length === 1 ? '' : 's'} ${listLines(lines)}, +${diff.added} -${diff.removed}`)

    if (values.diff === true && diff.unified !== '')
      process.stdout.write(diff.unified)
  }

  if (values['dry-run'] === true)
    console.log('dry run: nothing written')

  return 0
}

process.exitCode = await runMain({ name: 'sub', version, run: main })
