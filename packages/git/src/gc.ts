#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import { copyFileSync, existsSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import process from 'node:process'
import { badUsage, exitCodeOf, fail, holdSignals, jsonOption, parse, printError, printJson, runHint, runMain } from '@kaynooo/cli-kit'
import { git } from './git'
import { commitMessageViolation, RULE, TICKET } from './message'

const USAGE = `gc <title> [-m <line>]... [--ticket <line>]... -- <path>...: commits exactly the paths given, its message checked before anything is staged
gc <title> [-m <line>]... [--ticket <line>]... --staged: commits what is already staged in the index (e.g. after gu --commit or gm --squash)
gc [title] [-m <line>]... [--ticket <line>]... --amend [--staged | -- <path>...]: amends HEAD when not yet pushed to upstream

A merge, cherry-pick or revert in progress is refused, as git commits it only whole.
Exits 0 when it committed, 1 when the message is refused, HEAD is already pushed, a merge/cherry-pick/revert is in progress, or git fails (nothing is committed, the index is put back as it was), 2 on a usage error or outside a git repository, 128 plus the signal when interrupted.`

const OPTIONS = {
  message: { type: 'string', short: 'm', multiple: true, description: 'a line on what changed, at most two' },
  ticket: { type: 'string', multiple: true, description: 'a ticket line, `#<n> - <title>` (`owner/repo#<n> - <title>` across repositories) copied verbatim from the ticket' },
  staged: { type: 'boolean', short: 's', description: 'commit what is already staged in the index without naming paths' },
  amend: { type: 'boolean', description: 'amend HEAD (refused if HEAD is already on the upstream or is a merge)' },
  quiet: { type: 'boolean', short: 'q', description: 'print nothing once committed, failures aside' },
  json: jsonOption('{sha, subject, files: [{status, path, from?}]} of the commit'),
} as const

const RENAME = /^[RC]\d*$/
const NOT_A_REPOSITORY = /not a git repository/i
const TRAILING_SLASHES = /\/+$/
// What git can be in the middle of that it commits only whole, and what finishes it.
const SEQUENCES = [['MERGE_HEAD', 'a merge', 'gm --continue'], ['CHERRY_PICK_HEAD', 'a cherry-pick', 'git cherry-pick --continue'], ['REVERT_HEAD', 'a revert', 'git revert --continue']] as const
// Every path given is a file name, never a glob or a pathspec magic like :(top).
const LITERAL = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }

// The message as git will store it: the title, the description lines, then the ticket lines, each block after a blank line.
function messageOf(title: string, lines: string[], tickets: string[]): string {
  return [title, lines.join('\n'), tickets.join('\n')].filter(block => block !== '').join('\n\n')
}

async function checked(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await git(args, LITERAL)

  if (code !== 0)
    fail(`git ${args[0]} failed, nothing committed:\n${stderr.trim()}`, NOT_A_REPOSITORY.test(stderr) ? 2 : 1)

  return stdout
}

// The paths staged beyond the given ones, which a plain commit would carry along.
async function stagedElsewhere(paths: string[]): Promise<string[]> {
  const [all, given] = await Promise.all([checked(['diff', '--cached', '--name-only', '--no-relative', '-z']), checked(['diff', '--cached', '--name-only', '--no-relative', '-z', '--', ...paths])])
  const ours = new Set(given.split('\0'))

  return all.split('\0').filter(path => path !== '' && !ours.has(path))
}

// An absolute path with the links of its folder resolved, as the repository top git gives is; one whose folder is gone stays as given.
function onDisk(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path))
  }
  catch {
    return path
  }
}

// The old side of each staged rename whose new side the given paths cover, relative to the current folder: a rename is one change, which a pathspec on the new side alone would split.
async function renameSources(paths: string[]): Promise<string[]> {
  const [top = '', prefix = ''] = (await checked(['rev-parse', '--show-toplevel', '--show-prefix'])).split('\n')
  // Each path as git names it from the repository top, a folder covering what it holds.
  const specs = paths.map(path => (isAbsolute(path) ? relative(top, onDisk(path)) : join(prefix, path)).replace(TRAILING_SLASHES, '') || '.')
  const covered = (name: string) => specs.some(spec => spec === '.' || name === spec || name.startsWith(`${spec}/`))
  const fields = (await checked(['diff', '--cached', '-M', '--name-status', '--no-relative', '-z'])).split('\0')
  const sources: string[] = []

  for (let i = 0; i < fields.length; i++) {
    if (!RENAME.test(fields[i] ?? ''))
      continue

    const from = fields[i + 1] ?? ''
    const to = fields[i + 2] ?? ''

    if (covered(to) && !covered(from))
      sources.push(relative(prefix, from))

    i += 2
  }

  return sources
}

// The merge, cherry-pick or revert git is in the middle of, if any.
async function inProgress(): Promise<typeof SEQUENCES[number] | undefined> {
  const found = await Promise.all(SEQUENCES.map(async ([ref]) => (await git(['rev-parse', '-q', '--verify', ref])).code === 0))

  return SEQUENCES.find((_, i) => found[i])
}

// A copy of the index as gc found it, put back when no commit happens: a reset of the paths would drop what was staged on them before, a merge's resolution included.
async function snapshotIndex(): Promise<{ restore: () => void, drop: () => void }> {
  const index = (await checked(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
  const copy = `${index}.gc-${process.pid}`
  const existed = existsSync(index)

  if (existed)
    copyFileSync(index, copy)

  return {
    restore: () => existed ? renameSync(copy, index) : rmSync(index, { force: true }),
    drop: () => rmSync(copy, { force: true }),
  }
}

function fileLine(line: string): string {
  const [letter = '', from = '', to] = line.split('\t')

  return RENAME.test(letter) ? `  ${letter[0]} ${from} -> ${to}` : `  ${letter} ${from}`
}

async function checkAmendSafe(): Promise<void> {
  const read = await git(['log', '-1', '--format=%h%x00%P'], LITERAL)

  if (read.code !== 0)
    fail(NOT_A_REPOSITORY.test(read.stderr) ? 'not inside a git repository' : 'there is no commit to amend', NOT_A_REPOSITORY.test(read.stderr) ? 2 : 1)

  const [sha = '', parents = ''] = read.stdout.trim().split('\0')

  if ((await git(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'])).code === 0)
    fail(`${sha} is already on the upstream, refusing --amend (make a new commit instead)`, 1)

  if (parents.split(' ').filter(Boolean).length > 1)
    fail(`${sha} is a merge commit, gc does not amend merges`, 1)
}

async function reportCommit(values: { json?: boolean | undefined, quiet?: boolean | undefined }, sources: string[]): Promise<void> {
  const files = await checked(['show', '--format=%h %s', '--name-status', '-M', 'HEAD'])
  const [head = '', ...lines] = files.trimEnd().split('\n')

  if (values.json === true) {
    const changes = lines.filter(Boolean).map((line) => {
      const [letter = '', from = '', to] = line.split('\t')

      return RENAME.test(letter) ? { status: letter[0] ?? letter, path: to ?? from, from } : { status: letter, path: from }
    })

    printJson({ sha: (await checked(['rev-parse', 'HEAD'])).trim(), subject: head.slice(head.indexOf(' ') + 1), files: changes })
  }
  else if (values.quiet !== true) {
    console.log([head, ...lines.filter(Boolean).map(fileLine), ...sources.map(from => `also committed ${from}, the other side of a staged rename`)].join('\n'))
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, {
    rest: true,
    replaces: 'git add, git status and git commit chained',
    examples: [
      'gc "fix(api): retry a timed-out fetch" -- src/api.ts',
      ['gc "feat(ui): a dark theme" --staged', 'commit already-staged changes'],
      ['gc "fix(api): tighten message" --amend', 'amend unpushed HEAD'],
      ['gc "feat(ui): a dark theme" -m "The toggle sits in the header." --ticket "#12 - Dark theme" -- src/theme.ts src/header.ts', 'a body line and a ticket'],
    ],
  })

  const { values, positionals, rest = [] } = parsed
  const given = [...new Set(rest)]
  const staged = values.staged === true
  const amend = values.amend === true

  if (staged && given.length > 0)
    badUsage('--staged commits the index as it stands: pass no paths after --')

  if (amend) {
    if (positionals.length > 1)
      fail(`give at most one quoted title\n\n${USAGE}`)

    if (positionals.length === 0 && !staged && given.length === 0)
      fail(`--amend needs a new title, --staged, or paths after --\n\n${USAGE}`)
  }
  else {
    if (positionals.length !== 1)
      fail(`give the title as one quoted argument and the paths after -- (or --staged)\n\n${USAGE}`)

    if (!staged && given.length === 0)
      fail(`give the paths to commit after -- (or pass --staged)\n\n${USAGE}`)
  }

  let message: string | undefined

  if (positionals.length === 1) {
    const title = positionals[0]?.trim() ?? ''
    const tickets = values.ticket ?? []
    const wrong = tickets.find(line => !TICKET.test(line))

    if (wrong !== undefined)
      fail(`nothing staged: a ticket line reads \`#<n> - <title>\` or \`owner/repo#<n> - <title>\`, copied verbatim from the ticket, not: ${wrong}. ${RULE}`, 1)

    if (title === '')
      fail(`the title is empty\n\n${USAGE}`)

    message = messageOf(title, values.message ?? [], tickets)

    const violation = commitMessageViolation(message)

    if (violation !== null)
      fail(`nothing staged: ${violation}`, 1)
  }
  else if ((values.message?.length ?? 0) > 0 || (values.ticket?.length ?? 0) > 0) {
    badUsage('-m and --ticket need a title')
  }

  const sequence = await inProgress()

  if (sequence !== undefined)
    fail(`nothing staged: ${sequence[1]} is in progress, which git commits only whole`, 1, runHint(sequence[2], `finish ${sequence[1]}`))

  if (amend)
    await checkAmendSafe()

  // Committing already-staged changes (or message-only --amend).
  if (staged || (amend && given.length === 0)) {
    const stagedFiles = (await checked(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)

    if (staged && stagedFiles.length === 0)
      fail('nothing staged in the index to commit', 1, runHint('gst', 'see what changed'))

    const signals = holdSignals()

    try {
      const commitArgs = ['commit', '--cleanup=whitespace', ...(amend ? ['--amend'] : []), ...(message === undefined ? ['--no-edit'] : ['-m', message])]
      const commit = await git(commitArgs)

      if (commit.code !== 0) {
        const refusal = `git commit failed:\n${(commit.stderr + commit.stdout).trim()}`

        if (values.json === true)
          fail(refusal, 1)

        printError('gc', refusal)

        return 1
      }

      await reportCommit(values, [])

      return signals.signal === undefined ? 0 : exitCodeOf(null, signals.signal)
    }
    finally {
      signals.release()
    }
  }

  const statuses = await Promise.all(given.map(async path => checked(['status', '--porcelain', '--untracked-files=all', '--', path])))
  const unchanged = given.filter((_, i) => statuses[i] === '')
  // A path whose only change is a staged deletion (a git rm, the old side of a git mv) is in neither the tree nor the index, so git add refuses it, while commit --only still takes it.
  const addable = given.filter((_, i) => !(statuses[i] ?? '').trimEnd().split('\n').every(line => line.startsWith('D ')))

  if (unchanged.length > 0)
    fail(`nothing staged: no change to commit in ${unchanged.join(', ')} (unchanged, ignored or missing)`, 1, runHint('gst', 'see what changed'))

  const sources = await renameSources(given)
  const paths = [...given, ...sources]
  const others = await stagedElsewhere(paths)

  if (others.length > 0)
    fail(`nothing staged: the index already holds ${others.join(', ')}, which this commit would carry along`, 1, runHint(`git restore --staged -- ${others.join(' ')}`, 'unstage them, or name them in the paths too'))

  const index = await snapshotIndex()
  const signals = holdSignals()

  try {
    if (addable.length > 0)
      await checked(['add', '--', ...addable])

    if (signals.signal !== undefined) {
      index.restore()

      return exitCodeOf(null, signals.signal)
    }

    // The paths are literal one by one rather than through GIT_LITERAL_PATHSPECS, which the commit's hooks would inherit and read their own globs by.
    const commitArgs = ['commit', ...(amend ? ['--amend'] : []), '--only', '--cleanup=whitespace', ...(message === undefined ? ['--no-edit'] : ['-m', message]), '--', ...paths.map(path => `:(literal)${path}`)]
    const commit = await git(commitArgs)

    if (commit.code !== 0) {
      index.restore()

      const refusal = `git commit failed, the index was put back as it was:\n${(commit.stderr + commit.stdout).trim()}`

      if (values.json === true)
        fail(refusal, 1)

      printError('gc', refusal)

      return 1
    }

    await reportCommit(values, sources)

    return signals.signal === undefined ? 0 : exitCodeOf(null, signals.signal)
  }
  finally {
    index.drop()
    signals.release()
  }
}

process.exitCode = await runMain({ name: 'gc', run: main })
