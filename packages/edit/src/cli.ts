#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Diff } from './diff'
import type { Pair } from './replace'
import { accessSync, chmodSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import process from 'node:process'
import { Exit, fail, jsonOption, parse, printJson, readInput, role, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { counted, plural } from '@kaynooo/utils/text'
import { parseBlocks } from './blocks'
import { diffTexts } from './diff'
import { applyPairs, compile, listLines } from './replace'

const USAGE = `sub [options] <file>...: replaces text in files, writing nothing unless every replacement matches as often as expected

Multi-line text: give no --from, --to or --pairs and pipe SEARCH/REPLACE blocks on stdin from a quoted heredoc, which needs no escaping; a producer silent for 3 s is taken for no heredoc at all, so write a slow one to a file first. The blocks apply in order to the files on the command line, each matching exactly once unless --count or --all says otherwise:

sub src/a.php <<'EOF'
<<<<<<< SEARCH
old lines
=======
new lines
>>>>>>> REPLACE
EOF

A line naming a file before a block makes it apply to that file alone, so one call edits several files (no file argument needed when every block names one). An empty REPLACE deletes the SEARCH text; to drop whole lines, put the neighbouring line in both. When the text holds a marker line itself (a Markdown '=======' underline), open with more characters, '<<<<<<<<<< SEARCH', and divide and close with as many '=' and '>' too.`
const EXITS: ExitRow[] = [[0, 'it wrote every replacement'], [1, 'one did not match or a file cannot be written (nothing is written)'], [2, 'a usage error']]

const OPTIONS = {
  'from': { type: 'string', short: 'f', description: 'text to find, taken literally' },
  'to': { type: 'string', short: 't', description: 'text to put in its place, empty to delete it' },
  'count': { type: 'string', short: 'n', description: 'matches expected in each file (default 1)' },
  'all': { type: 'boolean', short: 'a', description: 'replace every match, expecting at least one in each file' },
  'skip-missing': { type: 'boolean', description: 'with --all, leave a file where no pair matches alone and list it, instead of failing; the counts still hold for the files that match' },
  'regex': { type: 'boolean', short: 'r', description: '--from is a regular expression (^ and $ match each line), --to may use $1, ${1}, $<name> and ${name}, and a \n or \t in it is a newline or a tab' }, // eslint-disable-line no-template-curly-in-string
  'ignore-case': { type: 'boolean', short: 'i', description: 'with --regex, match without regard to case' },
  'dotall': { type: 'boolean', short: 's', description: 'with --regex, let . match a newline too' },
  'pairs': { type: 'string', short: 'p', description: 'JSON array of {from, to, count?, all?, regex?, ignoreCase?, dotAll?} applied in order: inline when it starts with [, else a file or - for stdin' },
  'diff': { type: 'boolean', short: 'd', description: 'print each file\'s unified diff' },
  'dry-run': { type: 'boolean', description: 'show what would change without writing' },
  'quiet': { type: 'boolean', short: 'q', description: 'print nothing on success, the diff aside' },
  'json': jsonOption('{dryRun, files: [{path, replacements, lines, added, removed, diff?}], skipped? (the files --skip-missing left alone)}, or {error, failures: [{path, problem}]} on stderr when nothing is written'),
} as const

interface Defaults {
  count: number | undefined
  all: boolean
  regex: boolean
  ignoreCase: boolean
  dotAll: boolean
}

const PAIR_KEYS = ['from', 'to', 'count', 'all', 'regex', 'ignoreCase', 'dotAll']

function checkPattern(pair: Pair, label: string) {
  if (pair.from === '')
    fail(`${label}--from is empty`)

  if (pair.regex !== true)
    return

  try {
    compile(pair.from, pair)
  }
  catch (error) {
    fail(`${label}--from is no valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function pairFrom(item: unknown, i: number, defaults: Defaults): Pair {
  const label = `pair ${i + 1}: `

  if (typeof item !== 'object' || item === null || Array.isArray(item))
    fail(`${label}give an object {from, to}`)

  const { from, to, count, all, regex, ignoreCase, dotAll, ...rest } = item as Record<string, unknown>
  const unknown = Object.keys(rest)

  if (unknown.length > 0)
    fail(`${label}unknown ${plural('key', unknown.length)} ${unknown.join(', ')}, known: ${PAIR_KEYS.join(', ')}`)

  if (typeof from !== 'string' || typeof to !== 'string')
    fail(`${label}from and to must both be strings`)

  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1))
    fail(`${label}count takes a whole number from 1`)

  if ([all, regex, ignoreCase, dotAll].some(flag => flag !== undefined && typeof flag !== 'boolean'))
    fail(`${label}all, regex, ignoreCase and dotAll take true or false`)

  const pair: Pair = { from, to, count: count ?? defaults.count ?? 1, all: all ?? defaults.all, regex: regex ?? defaults.regex, ignoreCase: ignoreCase ?? defaults.ignoreCase, dotAll: dotAll ?? defaults.dotAll }

  if ((pair.ignoreCase === true || pair.dotAll === true) && pair.regex !== true)
    fail(`${label}ignoreCase and dotAll need regex`)

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

// How long stdin may stay silent before it is taken for one that will never close, as in a tool call with no heredoc.
const STDIN_SILENCE_MS = 3000

// The text piped on stdin; it ends the command at once on a terminal, and after a silence of `STDIN_SILENCE_MS` when nothing has arrived, since there is then no heredoc or pipe to wait for.
async function blocksOnStdin(files: string[]): Promise<string> {
  const extra = files.slice(1).filter(path => !existsSync(path))
  const strings = extra.length === 0 ? '' : `${extra.map(path => `no file ${path}`).join(', ')}: with several strings on the command line use --from and --to, as in sub --from old --to new ${files[0]}\n\n`
  const hint = `${strings}give --from and --to, or pipe SEARCH/REPLACE blocks on stdin from a heredoc\n\n${USAGE}`

  if (process.stdin.isTTY)
    fail(hint)

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    // fail() would only throw into a timer, so the usage error is printed and the process ended here, with its exit code.
    const timer = setTimeout(() => {
      console.error(`error: sub: ${hint}`)
      process.exit(2)
    }, STDIN_SILENCE_MS)

    process.stdin.on('data', (chunk: Buffer) => {
      clearTimeout(timer)
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)

      if (chunks.length === 0 && extra.length > 0) {
        console.error(`error: sub: ${hint}`)
        process.exit(2)
      }

      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
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

      pairs = [{ from: values.from, to: values.to, count: defaults.count ?? 1, all: defaults.all, regex: defaults.regex, ignoreCase: defaults.ignoreCase, dotAll: defaults.dotAll }]
      checkPattern(pairs[0] as Pair, '')
    }

    for (const path of files)
      edits.set(path, pairs)

    return edits
  }

  const blocks = parseBlocks(await blocksOnStdin(files))

  if (typeof blocks === 'string')
    fail(`blocks: ${blocks}`)

  for (const [i, block] of blocks.entries()) {
    const pair: Pair = { from: block.from, to: block.to, count: defaults.count ?? 1, all: defaults.all, regex: defaults.regex, ignoreCase: defaults.ignoreCase, dotAll: defaults.dotAll }
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
  const parsed = parse(argv, USAGE, OPTIONS, { exits: EXITS, replaces: 'sed -i and one-off bun -e or python editors', examples: [['sub src/a.php <<\'EOF\' (SEARCH/REPLACE blocks, see above)', 'multi-line text, no escaping'], ['sub --from oldName --to newName --all src/a.ts src/b.ts', 'every match in two files'], ['sub --regex --from "v(\\d+)" --to "v$1.0" --dry-run --diff README.md', 'the diff, nothing written']] })

  const { values, positionals } = parsed
  const files = dedupe(positionals.map(path => normalize(path)))

  if (values.count !== undefined && values.all === true)
    fail('--count and --all exclude each other')

  if (values['skip-missing'] === true && values.all !== true)
    fail('--skip-missing needs --all')

  if ((values['ignore-case'] === true || values.dotall === true) && values.regex !== true)
    fail('--ignore-case and --dotall need --regex')

  const defaults: Defaults = { count: values.count === undefined ? undefined : wholeNumber(values.count, 'count', 1), all: values.all === true, regex: values.regex === true, ignoreCase: values['ignore-case'] === true, dotAll: values.dotall === true }
  const edits = await plan(values, files, defaults)
  const changes: { path: string, before: string, after: string, lines: number[], diff?: Diff }[] = []
  const problems: { path: string, problem: string }[] = []
  const skipped: string[] = []

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

    if (values['skip-missing'] === true && applied.matched === 0) {
      skipped.push(path)

      continue
    }

    problems.push(...applied.problems.map(problem => ({ path, problem })))

    if (applied.problems.length === 0 && values['dry-run'] !== true && !writable(path))
      problems.push({ path, problem: 'not writable' })

    changes.push({ path, before, after: applied.text, lines: applied.lines })
  }

  const json = values.json === true

  if (skipped.length > 0 && changes.length === 0 && problems.length === 0)
    problems.push({ path: skipped.join(', '), problem: 'no match in any file' })

  if (problems.length > 0) {
    if (json)
      console.error(JSON.stringify({ error: 'nothing written', failures: problems }))
    else
      console.error(`${role('problem', process.stderr)('sub: nothing written')}\n${problems.map(({ path, problem }) => `${path}: ${problem}`).join('\n')}`)

    return 1
  }

  try {
    for (const change of changes)
      change.diff = await diffTexts(change.path, change.before, change.after)
  }
  catch (error) {
    console.error(`${role('problem', process.stderr)('sub: nothing written')}\n${error instanceof Error ? error.message : String(error)}`)

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
      console.log(`${role('path', process.stdout)(path)}: ${counted(lines.length, 'replacement')} on ${plural('line', lines.length, { zero: 'plural' })} ${listLines(lines)}, ${role(diff.added === 0 ? 'label' : 'ok', process.stdout)(`+${diff.added}`)} ${role(diff.removed === 0 ? 'label' : 'problem', process.stdout)(`-${diff.removed}`)}`)

    if (values.diff === true && diff.unified !== '')
      process.stdout.write(diff.unified)
  }

  if (json)
    printJson({ dryRun: values['dry-run'] === true, files: done, ...values['skip-missing'] === true ? { skipped } : {} })
  else if (values.quiet !== true && skipped.length > 0)
    console.log(`skipped ${counted(skipped.length, 'file')} with no match: ${skipped.join(', ')}`)

  if (!json && values['dry-run'] === true && values.quiet !== true)
    console.log('dry run: nothing written')

  return 0
}

process.exitCode = await runMain({ name: 'sub', run: main })
