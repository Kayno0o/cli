#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Diff } from './diff'
import type { LineRange, Pair } from './replace'
import type { WalkFilter } from './walk'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import process from 'node:process'
import { Exit, fail, jsonOption, parse, printJson, readInput, role, runMain, wholeNumber, writeErr, xdgFolder } from '@kaynooo/cli-kit'
import { counted, plural } from '@kaynooo/utils/text'
import { parseBlocks } from './blocks'
import { diffTexts } from './diff'
import { applyPairs, compile, listLines } from './replace'
import { filesIn } from './walk'

const USAGE = `sub [options] <file>...: replaces text in files, writing nothing unless every replacement matches as often as expected

A folder given as a file is walked, .gitignore respected and binary files left out.

Multi-line text: give no --from, --to or --pairs and pipe SEARCH/REPLACE blocks on stdin from a quoted heredoc, which needs no escaping. The blocks apply in order to the files on the command line, each matching exactly once unless --count or --all says otherwise:

sub src/a.php <<'EOF'
<<<<<<< SEARCH
old lines
=======
new lines
>>>>>>> REPLACE
EOF

A line naming a file before a block makes it apply to that file alone, and an empty REPLACE deletes the SEARCH text.`
const EXITS: ExitRow[] = [[0, 'it wrote every replacement'], [1, 'one did not match or a file cannot be written (nothing is written)'], [2, 'a usage error']]

const OPTIONS = {
  'from': { type: 'string', short: 'f', description: 'text to find, taken literally' },
  'to': { type: 'string', short: 't', description: 'text to put in its place, empty to delete it' },
  'count': { type: 'string', short: 'n', description: 'matches expected in each file (default 1)' },
  'all': { type: 'boolean', short: 'a', description: 'replace every match, expecting at least one in each file, or exactly --count' },
  'word': { type: 'boolean', short: 'w', description: 'match whole words only' },
  'skip-missing': { type: 'boolean', description: 'with --all, leave a file where no pair matches alone and list it, instead of failing; the counts still hold for the files that match' },
  'regex': { type: 'boolean', short: 'r', description: '--from is a regular expression (^ and $ match each line), --to may use $1, ${1}, $<name> and ${name}, and a \\n or \\t in it is a newline or a tab, \\\\ a backslash' }, // eslint-disable-line no-template-curly-in-string
  'ignore-case': { type: 'boolean', short: 'i', description: 'with --regex, match without regard to case' },
  'dotall': { type: 'boolean', short: 's', description: 'with --regex, let . match a newline too' },
  'pairs': { type: 'string', short: 'p', description: 'JSON array of {from, to, count?, all?, word?, regex?, ignoreCase?, dotAll?} applied in order: inline when it starts with [, else a file or - for stdin' },
  'glob': { type: 'string', multiple: true, description: 'when walking folders, keep only files matching this glob, repeatable' },
  'ext': { type: 'string', multiple: true, description: 'when walking folders, keep only these extensions (comma-separated, e.g. ts,tsx), repeatable' },
  'exclude': { type: 'string', multiple: true, description: 'when walking folders, skip files matching this glob, repeatable' },
  'undo': { type: 'boolean', description: 'restore the files modified by the last sub run in this directory' },
  'diff': { type: 'boolean', short: 'd', description: 'print each file\'s unified diff' },
  'dry-run': { type: 'boolean', description: 'show what would change without writing' },
  'quiet': { type: 'boolean', short: 'q', description: 'print nothing on success, the diff aside' },
  'json': jsonOption('{dryRun, files: [{path, replacements, lines, added, removed, diff?}], skipped? (the files --skip-missing left alone)}, or {error, failures: [{path, problem}]} on stderr when nothing is written'),
} as const

interface Defaults {
  count: number | undefined
  all: boolean
  word: boolean
  regex: boolean
  ignoreCase: boolean
  dotAll: boolean
}

const PAIR_KEYS = ['from', 'to', 'count', 'all', 'word', 'regex', 'ignoreCase', 'dotAll']
const FILE_RANGE = /^(.+?):(\d+)(?:-(\d+))?$/
const LEADING_DOT = /^\./

interface UndoEntry {
  cwd: string
  at: string
  files: { path: string, target: string, before: string, after: string }[]
}

function undoFile(): string {
  return join(xdgFolder(process.env.XDG_STATE_HOME, join(homedir(), '.local', 'state')), 'sub', 'undo.json')
}

function loadUndoMap(): Record<string, UndoEntry> {
  const file = undoFile()

  if (!existsSync(file))
    return {}

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, UndoEntry>
  }
  catch {
    return {}
  }
}

function saveUndo(cwd: string, files: { path: string, before: string, after: string }[]): void {
  if (files.length === 0)
    return

  try {
    const key = canonical(cwd)
    const map = loadUndoMap()

    map[key] = {
      cwd: key,
      at: new Date().toISOString(),
      files: files.map(({ path, before, after }) => ({ path, target: canonical(path), before, after })),
    }

    // Keep at most 20 recent directories.
    const entries = Object.entries(map).sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, 20)
    const file = undoFile()

    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(entries)))
  }
  catch {
    // Best-effort undo persistence; read-only state dirs never fail an edit.
  }
}

function runUndo(dryRun: boolean, showDiff: boolean, quiet: boolean, json: boolean): number {
  const key = canonical(process.cwd())
  const map = loadUndoMap()
  const entry = map[key]

  if (entry === undefined || entry.files.length === 0)
    return nothingWritten([{ path: '', problem: 'nothing to undo in this directory' }], json)

  const problems: Problem[] = []
  const restores: { path: string, target: string, before: string, after: string, diff: Diff }[] = []

  for (const file of entry.files) {
    if (!existsSync(file.target)) {
      problems.push({ path: file.path, problem: 'no longer exists' })

      continue
    }

    const current = readUtf8(file.target)

    if (current !== file.after) {
      problems.push({ path: file.path, problem: 'file changed since last sub edit; refusing to overwrite' })

      continue
    }

    if (!dryRun && !writable(file.target)) {
      problems.push({ path: file.path, problem: 'not writable' })

      continue
    }

    restores.push({ path: file.path, target: file.target, before: current, after: file.before, diff: diffTexts(file.path, current, file.before) })
  }

  if (problems.length > 0)
    return nothingWritten(problems, json)

  if (!dryRun) {
    const failed = writeAll(restores.map(({ target, after }) => ({ path: target, text: after })))

    if (failed !== undefined)
      return nothingWritten([failed], json)

    delete map[key]
    writeFileSync(undoFile(), JSON.stringify(map))
  }

  const done = restores.map(({ path, diff }) => ({ path, replacements: 1, lines: [], added: diff.added, removed: diff.removed, ...(showDiff ? { diff: diff.unified } : {}) }))

  if (json) {
    printJson({ dryRun, undone: true, files: done })

    return 0
  }

  for (const { path, diff } of restores) {
    if (!quiet)
      console.log(`${role('path', process.stdout)(path)}: restored, ${role(diff.added === 0 ? 'label' : 'ok', process.stdout)(`+${diff.added}`)} ${role(diff.removed === 0 ? 'label' : 'problem', process.stdout)(`-${diff.removed}`)}`)

    if (showDiff && diff.unified !== '')
      process.stdout.write(diff.unified)
  }

  if (dryRun && !quiet)
    console.log('dry run: nothing written')

  return 0
}

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

function isFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function pairFrom(item: unknown, i: number, defaults: Defaults): Pair {
  const label = `pair ${i + 1}: `

  if (typeof item !== 'object' || item === null || Array.isArray(item))
    fail(`${label}give an object {from, to}`)

  const { from, to, count, all, word, regex, ignoreCase, dotAll, ...rest } = item as Record<string, unknown>
  const unknown = Object.keys(rest)

  if (unknown.length > 0)
    fail(`${label}unknown ${plural('key', unknown.length)} ${unknown.join(', ')}, known: ${PAIR_KEYS.join(', ')}`)

  if (typeof from !== 'string' || typeof to !== 'string')
    fail(`${label}from and to must both be strings`)

  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1))
    fail(`${label}count takes a whole number from 1`)

  if (!isFlag(all) || !isFlag(word) || !isFlag(regex) || !isFlag(ignoreCase) || !isFlag(dotAll))
    fail(`${label}all, word, regex, ignoreCase and dotAll take true or false`)

  const pair: Pair = { from, to, count: count ?? defaults.count ?? 1, all: count === undefined ? all ?? defaults.all : false, word: word ?? defaults.word, regex: regex ?? defaults.regex, ignoreCase: ignoreCase ?? defaults.ignoreCase, dotAll: dotAll ?? defaults.dotAll }

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

// The file and the folder its temp file is written in, which the rename needs too.
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    accessSync(dirname(realpathSync(path)), constants.W_OK)

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

interface Staged { temp: string, target: string }
interface Problem { path: string, problem: string }

// Writes every new text next to its target first, then renames them all over their targets, so a write that fails leaves every file as it was and is answered; a symlink is followed and the mode kept.
function writeAll(writes: { path: string, text: string }[]): Problem | undefined {
  const staged: Staged[] = []

  for (const { path, text } of writes) {
    try {
      const target = realpathSync(path)
      const temp = `${target}.sub-${process.pid}`

      staged.push({ temp, target })
      writeFileSync(temp, text)
      chmodSync(temp, (statSync(target, { throwIfNoEntry: false })?.mode ?? 0o644) & 0o7777)
    }
    catch (error) {
      for (const { temp } of staged)
        rmSync(temp, { force: true })

      return { path, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  // A rename failing past the first (another device, a race) leaves the earlier ones done: the temp files left are removed and the error reaches the caller as it is.
  for (const [index, { temp, target }] of staged.entries()) {
    try {
      renameSync(temp, target)
    }
    catch (error) {
      for (const left of staged.slice(index))
        rmSync(left.temp, { force: true })

      throw error
    }
  }

  return undefined
}

function nothingWritten(problems: Problem[], json: boolean): number {
  writeErr(json ? JSON.stringify({ error: 'nothing written', failures: problems }) : `${role('problem', process.stderr)('sub: nothing written')}\n${problems.map(({ path, problem }) => path === '' ? problem : `${path}: ${problem}`).join('\n')}`)

  return 1
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
      writeErr(`error: sub: ${hint}`)
      process.exit(2)
    }, STDIN_SILENCE_MS)

    process.stdin.on('data', (chunk: Buffer) => {
      clearTimeout(timer)
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)

      if (chunks.length === 0 && extra.length > 0) {
        writeErr(`error: sub: ${hint}`)
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

      pairs = [{ from: values.from, to: values.to, count: defaults.count ?? 1, all: defaults.all, word: defaults.word, regex: defaults.regex, ignoreCase: defaults.ignoreCase, dotAll: defaults.dotAll }]
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
    const pair: Pair = { from: block.from, to: block.to, count: defaults.count ?? 1, all: defaults.all, word: defaults.word, regex: defaults.regex, ignoreCase: defaults.ignoreCase, dotAll: defaults.dotAll }
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

  if (values.undo === true)
    return runUndo(values['dry-run'] === true, values.diff === true, values.quiet === true, values.json === true)

  const exts = (values.ext ?? []).flatMap(item => item.split(',').map(ext => ext.trim().replace(LEADING_DOT, '').toLowerCase()).filter(Boolean))
  const walkFilter: WalkFilter | undefined = (values.glob?.length ?? 0) > 0 || exts.length > 0 || (values.exclude?.length ?? 0) > 0
    ? { ...(values.glob === undefined ? {} : { globs: values.glob }), ...(exts.length === 0 ? {} : { exts }), ...(values.exclude === undefined ? {} : { excludes: values.exclude }) }
    : undefined
  const walked = new Set<string>()
  const ranges = new Map<string, LineRange>()
  const given = await Promise.all(positionals.map(async (rawPath) => {
    if (!existsSync(rawPath)) {
      const rangeMatch = FILE_RANGE.exec(rawPath)

      if (rangeMatch !== null && existsSync(rangeMatch[1]!)) {
        const clean = normalize(rangeMatch[1]!)
        const from = Number(rangeMatch[2])
        const to = Number(rangeMatch[3] ?? rangeMatch[2])

        ranges.set(canonical(clean), { from, to })

        return [clean]
      }
    }

    if (statSync(rawPath, { throwIfNoEntry: false })?.isDirectory() !== true)
      return [normalize(rawPath)]

    const inside = (await filesIn(rawPath, walkFilter)).map(normalize)

    for (const file of inside)
      walked.add(file)

    return inside
  }))
  const files = dedupe(given.flat())

  if (values['skip-missing'] === true && values.all !== true)
    fail('--skip-missing needs --all')

  if ((values['ignore-case'] === true || values.dotall === true) && values.regex !== true)
    fail('--ignore-case and --dotall need --regex')

  // --count with --all checks the exact count, the stricter reading of what both ask for.
  const defaults: Defaults = { count: values.count === undefined ? undefined : wholeNumber(values.count, 'count', 1), all: values.all === true && values.count === undefined, word: values.word === true, regex: values.regex === true, ignoreCase: values['ignore-case'] === true, dotAll: values.dotall === true }
  const edits = await plan(values, files, defaults)
  const changes: { path: string, before: string, after: string, lines: number[], diff?: Diff }[] = []
  const problems: Problem[] = []
  const skipped: string[] = []

  for (const [path, pairs] of edits) {
    if (!existsSync(path)) {
      problems.push({ path, problem: 'no such file' })

      continue
    }

    const before = readUtf8(path)

    if (before === undefined && walked.has(path))
      continue

    if (before === undefined) {
      problems.push({ path, problem: 'not valid UTF-8, left alone' })

      continue
    }

    const applied = applyPairs(before, pairs, ranges.get(canonical(path)))

    if ((values['skip-missing'] === true || walked.has(path)) && applied.matched === 0) {
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

  if (problems.length > 0)
    return nothingWritten(problems, json)

  for (const change of changes)
    change.diff = diffTexts(change.path, change.before, change.after)

  const done: { path: string, replacements: number, lines: number[], added: number, removed: number, diff?: string }[] = []
  const modified = changes.filter(({ before, after, diff }) => diff !== undefined && after !== before)

  const failed = values['dry-run'] === true ? undefined : writeAll(modified.map(({ path, after }) => ({ path, text: after })))

  if (failed !== undefined)
    return nothingWritten([failed], json)

  if (values['dry-run'] !== true && modified.length > 0)
    saveUndo(process.cwd(), modified)

  for (const { path, lines, diff } of changes) {
    if (diff === undefined)
      continue

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
