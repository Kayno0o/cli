#!/usr/bin/env -S bun --no-env-file

import type { Diff } from './diff'
import type { Pair } from './replace'
import { accessSync, chmodSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import process from 'node:process'
import { Exit, fail, jsonOption, parse, printJson, readInput, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { parseBlocks } from './blocks'
import { diffTexts } from './diff'
import { applyPairs, compile, listLines } from './replace'

const USAGE = `sub [options] <file>...: replaces text in files, writing nothing unless every replacement matches as often as expected

Multi-line text: give no --from, --to or --pairs and pipe SEARCH/REPLACE blocks on stdin from a quoted heredoc, which needs no escaping. The blocks apply in order to the files on the command line, each matching exactly once unless --count or --all says otherwise:

sub src/a.php <<'EOF'
<<<<<<< SEARCH
old lines
=======
new lines
>>>>>>> REPLACE
EOF

A line naming a file before a block makes it apply to that file alone, so one call edits several files (no file argument needed when every block names one). An empty REPLACE deletes the SEARCH text; to drop whole lines, put the neighbouring line in both. When the text holds a marker line itself (a Markdown '=======' underline), open with more characters, '<<<<<<<<<< SEARCH', and divide and close with as many '=' and '>' too.

Exits 0 when it wrote every replacement, 1 when one did not match or a file cannot be written (nothing is written), 2 on a usage error.`

const OPTIONS = {
  'from': { type: 'string', short: 'f', description: 'text to find, taken literally' },
  'to': { type: 'string', short: 't', description: 'text to put in its place, empty to delete it' },
  'count': { type: 'string', short: 'n', description: 'matches expected in each file (default 1)' },
  'all': { type: 'boolean', short: 'a', description: 'replace every match, expecting at least one in each file' },
  'regex': { type: 'boolean', short: 'r', description: '--from is a regular expression (^ and $ match each line), --to may use $1, ${1}, $<name> and ${name}' }, // eslint-disable-line no-template-curly-in-string
  'pairs': { type: 'string', short: 'p', description: 'JSON array of {from, to, count?, all?, regex?} applied in order: inline when it starts with [, else a file or - for stdin' },
  'diff': { type: 'boolean', short: 'd', description: 'print each file\'s unified diff' },
  'dry-run': { type: 'boolean', description: 'show what would change without writing' },
  'quiet': { type: 'boolean', short: 'q', description: 'print nothing on success, the diff aside' },
  'json': jsonOption('{dryRun, files: [{path, replacements, lines, added, removed, diff?}]}, or {error, failures: [{path, problem}]} on stderr when nothing is written'),
} as const

interface Defaults {
  count: number | undefined
  all: boolean
  regex: boolean
}

const PAIR_KEYS = ['from', 'to', 'count', 'all', 'regex']

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

  const { from, to, count, all, regex, ...rest } = item as Record<string, unknown>
  const unknown = Object.keys(rest)

  if (unknown.length > 0)
    fail(`${label}unknown key${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}, known: ${PAIR_KEYS.join(', ')}`)

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
    items = JSON.parse(path.trimStart().startsWith('[') ? path : await readInput(path, { noStdin: 'pipe the pairs on stdin, or give their file to --pairs' }))
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

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The file's text, or undefined when its bytes are not valid UTF-8 and would not survive a round trip.
function readUtf8(path: string): string | undefined {
  try {
    return UTF8.decode(readFileSync(path))
  }
  catch {
    return undefined
  }
}

// One spelling per file, so `a.txt` and its absolute path or a link to it gather their edits instead of the last write dropping the others'.
function canonical(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return resolve(path)
  }
}

function dedupe(paths: string[]): string[] {
  const byFile = new Map<string, string>()

  for (const path of paths) {
    const key = canonical(path)

    if (!byFile.has(key))
      byFile.set(key, path)
  }

  return [...byFile.values()]
}

// Writes next to the target then renames over it, so a crash never leaves half a file; a symlink is followed and the mode kept.
function writeAtomic(path: string, text: string) {
  const target = realpathSync(path)
  const temp = `${target}.sub-${process.pid}`

  try {
    writeFileSync(temp, text)
    chmodSync(temp, (statSync(target, { throwIfNoEntry: false })?.mode ?? 0o644) & 0o7777)
    renameSync(temp, target)
  }
  catch (error) {
    rmSync(temp, { force: true })

    throw error
  }
}

// The pairs each file gets: the one set of --from/--to or --pairs for every file argument, or the stdin blocks, each for the file it names or else for the file arguments.
async function plan(values: { from?: string, to?: string, pairs?: string }, files: string[], defaults: Defaults): Promise<Map<string, Pair[]>> {
  const edits = new Map<string, Pair[]>()
  // each file under the first spelling given for it
  const spellings = new Map(files.map(path => [canonical(path), path]))

  if (values.pairs !== undefined || values.from !== undefined || values.to !== undefined) {
    if (files.length === 0)
      fail(`give at least one file\n\n${USAGE}`)

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

    for (const path of files)
      edits.set(path, pairs)

    return edits
  }

  const blocks = parseBlocks(await readInput('-', { noStdin: `give --from and --to, or pipe SEARCH/REPLACE blocks on stdin\n\n${USAGE}` }))

  if (typeof blocks === 'string')
    fail(`blocks: ${blocks}`)

  for (const [i, block] of blocks.entries()) {
    const pair: Pair = { from: block.from, to: block.to, count: defaults.count ?? 1, all: defaults.all, regex: defaults.regex }
    const named = block.file === undefined ? undefined : normalize(block.file)
    const targets = named === undefined ? files : [spellings.get(canonical(named)) ?? named]

    if (named !== undefined && !spellings.has(canonical(named)))
      spellings.set(canonical(named), named)

    checkPattern(pair, `block ${i + 1}: `)

    if (targets.length === 0)
      fail(`block ${i + 1} names no file and none is given as an argument`)

    for (const path of targets)
      edits.set(path, [...edits.get(path) ?? [], pair])
  }

  for (const path of files) {
    if (!edits.has(path))
      fail(`no block applies to ${path}`)
  }

  return edits
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { replaces: 'sed -i and one-off bun -e or python editors', examples: [['sub src/a.php <<\'EOF\' (SEARCH/REPLACE blocks, see above)', 'multi-line text, no escaping'], ['sub --from oldName --to newName --all src/a.ts src/b.ts', 'every match in two files'], ['sub --regex --from "v(\\d+)" --to "v$1.0" --dry-run --diff README.md', 'the diff, nothing written']] })

  const { values, positionals } = parsed
  const files = dedupe(positionals.map(path => normalize(path)))

  if (values.count !== undefined && values.all === true)
    fail('--count and --all exclude each other')

  const defaults: Defaults = { count: values.count === undefined ? undefined : wholeNumber(values.count, 'count', 1), all: values.all === true, regex: values.regex === true }
  const edits = await plan(values, files, defaults)
  const changes: { path: string, before: string, after: string, lines: number[], diff?: Diff }[] = []
  const problems: { path: string, problem: string }[] = []

  for (const [path, pairs] of edits) {
    if (!existsSync(path)) {
      problems.push({ path, problem: 'no such file' })

      continue
    }

    const before = readUtf8(path)

    if (before === undefined) {
      problems.push({ path, problem: 'not valid UTF-8, left alone' })

      continue
    }

    const applied = applyPairs(before, pairs)

    problems.push(...applied.problems.map(problem => ({ path, problem })))

    if (applied.problems.length === 0 && values['dry-run'] !== true && !writable(path))
      problems.push({ path, problem: 'not writable' })

    changes.push({ path, before, after: applied.text, lines: applied.lines })
  }

  const json = values.json === true

  if (problems.length > 0) {
    if (json)
      console.error(JSON.stringify({ error: 'nothing written', failures: problems }))
    else
      console.error(`sub: nothing written\n${problems.map(({ path, problem }) => `${path}: ${problem}`).join('\n')}`)

    return 1
  }

  try {
    for (const change of changes)
      change.diff = await diffTexts(change.path, change.before, change.after)
  }
  catch (error) {
    console.error(`sub: nothing written\n${error instanceof Error ? error.message : String(error)}`)

    return 1
  }

  const done: { path: string, replacements: number, lines: number[], added: number, removed: number, diff?: string }[] = []

  for (const { path, before, after, lines, diff } of changes) {
    if (diff === undefined)
      continue

    if (values['dry-run'] !== true && after !== before)
      writeAtomic(path, after)

    if (json) {
      done.push({ path, replacements: lines.length, lines, added: diff.added, removed: diff.removed, ...values.diff === true ? { diff: diff.unified } : {} })

      continue
    }

    if (values.quiet !== true)
      console.log(`${path}: ${plural(lines.length, 'replacement')} on line${lines.length === 1 ? '' : 's'} ${listLines(lines)}, +${diff.added} -${diff.removed}`)

    if (values.diff === true && diff.unified !== '')
      process.stdout.write(diff.unified)
  }

  if (json)
    printJson({ dryRun: values['dry-run'] === true, files: done })
  else if (values['dry-run'] === true && values.quiet !== true)
    console.log('dry run: nothing written')

  return 0
}

process.exitCode = await runMain({ name: 'sub', run: main })
