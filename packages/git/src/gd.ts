#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, fail, jsonOption, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { git } from './git'
import { toplevelOf } from './repos'

const USAGE = `gd [path]...: what changed in the tracked files, per file with its added and removed lines, then the patch of the paths given

With no path it lists the files, staged apart from unstaged; with paths (or --patch) it prints the patch of those files instead, in the colours of view when it is installed and the output is a terminal. Untracked files are gst's.
--ref compares the working tree to a commit, branch or tag instead (gd --ref main), and --ref a..b compares two commits.`

const EXITS: ExitRow[] = [[0, 'it printed the changes, or there were none'], [1, 'git refused, a ref it does not know for one'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  staged: { type: 'boolean', short: 's', description: 'only what is staged' },
  ref: { type: 'string', description: 'compare to this commit, branch or tag, or a..b, instead of the index' },
  patch: { type: 'boolean', short: 'p', description: 'print the patch of every file listed, not just of the paths given' },
  json: jsonOption('[{title, files: [{path, added, removed}]}] per section, added and removed being null for a binary file'),
} as const

const LITERAL = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
const NOT_A_REPOSITORY = /not a git repository/i

interface File { path: string, added: number | null, removed: number | null }
interface Section { title: string, args: string[], files: File[] }

// `git diff --numstat -z`: `added<TAB>removed<TAB>path`, a rename as an empty path then the old and the new one.
function parseNumstat(text: string): File[] {
  const fields = text.split('\0')
  const files: File[] = []

  for (let at = 0; at < fields.length; at++) {
    const field = fields[at] ?? ''
    const first = field.indexOf('\t')
    const second = field.indexOf('\t', first + 1)

    if (first < 0 || second < 0)
      continue

    // A path may hold a tab, so only the first two split the field.
    const added = field.slice(0, first)
    const removed = field.slice(first + 1, second)
    const path = field.slice(second + 1)
    const count = (value: string): number | null => value === '-' ? null : Number(value)

    if (path === '') {
      files.push({ path: fields[at + 2] ?? '', added: count(added), removed: count(removed) })
      at += 2
    }
    else {
      files.push({ path, added: count(added), removed: count(removed) })
    }
  }

  return files
}

async function diff(args: string[], paths: string[]): Promise<string> {
  const ran = await git(['diff', ...args, '--', ...paths], LITERAL)

  if (ran.code !== 0)
    fail(`git diff failed:\n${ran.stderr.trim()}`, NOT_A_REPOSITORY.test(ran.stderr) ? 2 : 1)

  return ran.stdout
}

// The patch on stdout, through view on a terminal when it is installed.
async function show(patch: string): Promise<void> {
  const viewer = process.stdout.isTTY ? Bun.which('view') : null

  if (viewer === null) {
    process.stdout.write(patch)

    return
  }

  const child = Bun.spawn([viewer, '--diff'], { stdin: new TextEncoder().encode(patch), stdout: 'inherit', stderr: 'inherit' })

  await child.exited
}

function sections(values: { staged?: boolean | undefined, ref?: string | undefined }): Pick<Section, 'title' | 'args'>[] {
  if (values.ref !== undefined)
    return [{ title: `against ${values.ref}`, args: [values.ref] }]

  if (values.staged === true)
    return [{ title: 'staged', args: ['--cached'] }]

  return [{ title: 'staged', args: ['--cached'] }, { title: 'unstaged', args: [] }]
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['[path]...'], exits: EXITS, replaces: 'git diff --stat, git diff --cached --stat and then git diff <path>', examples: ['gd', ['gd src/a.ts', 'the patch of one file'], ['gd --staged -p', 'the patch of everything staged'], ['gd --ref main', 'the working tree against main']] })

  if (values.ref?.startsWith('-') === true)
    badUsage(`--ref takes a commit, branch or tag, not ${values.ref}`)

  if (values.ref !== undefined && values.staged === true)
    badUsage('--ref and --staged exclude each other: --ref compares the working tree')

  if (await toplevelOf('.') === undefined)
    fail('not inside a git repository', 2)

  const wanted = sections(values)

  if (positionals.length > 0 || values.patch === true) {
    const patches = await Promise.all(wanted.map(async each => diff(each.args, positionals)))

    await show(patches.join(''))

    return 0
  }

  const found: Section[] = await Promise.all(wanted.map(async each => ({ ...each, files: parseNumstat(await diff([...each.args, '--numstat', '-z'], [])) })))

  if (values.json === true) {
    printJson(found.map(({ title, files }) => ({ title, files })))

    return 0
  }

  const { dim } = paint(process.stdout)
  const green = role('ok', process.stdout)
  const red = role('problem', process.stdout)
  const shown = found.filter(each => each.files.length > 0)

  if (shown.length === 0) {
    console.log(dim('no change in the tracked files'))

    return 0
  }

  console.log(shown.map(each => `${each.title}\n${table(each.files.map(file => [role('path', process.stdout)(file.path), file.added === null ? dim('binary') : green(`+${file.added}`), file.removed === null ? '' : red(`-${file.removed}`)]))}`).join('\n\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gd', run: main })
