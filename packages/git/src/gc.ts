#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import process from 'node:process'
import { exitCodeOf, fail, holdSignals, jsonOption, parse, printError, printJson, runHint, runMain } from '@kaynooo/cli-kit'
import { git } from './git'
import { commitMessageViolation, RULE, TICKET } from './message'

const USAGE = 'gc <title> [-m <line>]... [--ticket <line>]... -- <path>...: commits exactly the paths given, its message checked before anything is staged\n\nExits 0 when it committed, 1 when the message is refused or git fails (nothing is committed), 2 on a usage error or outside a git repository, 128 plus the signal when interrupted.'

const OPTIONS = {
  message: { type: 'string', short: 'm', multiple: true, description: 'a line on what changed, at most two' },
  ticket: { type: 'string', multiple: true, description: 'a ticket line, `#<n> - <title>` (`owner/repo#<n> - <title>` across repositories) copied verbatim from the ticket' },
  quiet: { type: 'boolean', short: 'q', description: 'print nothing once committed, failures aside' },
  json: jsonOption('{sha, subject, files: [{status, path, from?}]} of the commit'),
} as const

const RENAME = /^[RC]\d*$/
const NOT_A_REPOSITORY = /not a git repository/i
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
  const [all, given] = await Promise.all([checked(['diff', '--cached', '--name-only', '-z']), checked(['diff', '--cached', '--name-only', '-z', '--', ...paths])])
  const ours = new Set(given.split('\0'))

  return all.split('\0').filter(path => path !== '' && !ours.has(path))
}

// Puts the index back as it was for the given paths after a refused commit.
async function unstage(paths: string[]): Promise<void> {
  const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], LITERAL)).code === 0

  await git(hasHead ? ['reset', '-q', '--', ...paths] : ['rm', '-r', '-q', '--cached', '--', ...paths], LITERAL)
}

function fileLine(line: string): string {
  const [letter = '', from = '', to] = line.split('\t')

  return RENAME.test(letter) ? `  ${letter[0]} ${from} -> ${to}` : `  ${letter} ${from}`
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { rest: true, replaces: 'git add, git status and git commit chained', examples: ['gc "fix(api): retry a timed-out fetch" -- src/api.ts', ['gc "feat(ui): a dark theme" -m "The toggle sits in the header." --ticket "#12 - Dark theme" -- src/theme.ts src/header.ts', 'a body line and a ticket']] })

  const { values, positionals, rest = [] } = parsed
  const paths = [...new Set(rest)]

  if (positionals.length !== 1)
    fail(`give the title as one quoted argument and the paths after --\n\n${USAGE}`)

  if (paths.length === 0)
    fail(`give the paths to commit after --\n\n${USAGE}`)

  const title = positionals[0]?.trim() ?? ''
  const tickets = values.ticket ?? []
  const wrong = tickets.find(line => !TICKET.test(line))

  if (wrong !== undefined)
    fail(`nothing staged: a ticket line reads \`#<n> - <title>\` or \`owner/repo#<n> - <title>\`, copied verbatim from the ticket, not: ${wrong}. ${RULE}`, 1)

  if (title === '')
    fail(`the title is empty\n\n${USAGE}`)

  const message = messageOf(title, values.message ?? [], tickets)
  const violation = commitMessageViolation(message)

  if (violation !== null)
    fail(`nothing staged: ${violation}`, 1)

  const statuses = await Promise.all(paths.map(async path => checked(['status', '--porcelain', '--untracked-files=all', '--', path])))
  const unchanged = paths.filter((_, i) => statuses[i] === '')
  // A path whose only change is a staged deletion (a git rm, the old side of a git mv) is in neither the tree nor the index, so git add refuses it, while commit --only still takes it.
  const addable = paths.filter((_, i) => !(statuses[i] ?? '').trimEnd().split('\n').every(line => line.startsWith('D ')))

  if (unchanged.length > 0)
    fail(`nothing staged: no change to commit in ${unchanged.join(', ')} (unchanged, ignored or missing)`, 1, runHint('gst', 'see what changed'))

  const others = await stagedElsewhere(paths)

  if (others.length > 0)
    fail(`nothing staged: the index already holds ${others.join(', ')}, which this commit would carry along`, 1, runHint(`git restore --staged -- ${others.join(' ')}`, 'unstage them, or name them in the paths too'))

  const signals = holdSignals()

  try {
    if (addable.length > 0)
      await checked(['add', '--', ...addable])

    if (signals.signal !== undefined) {
      await unstage(paths)

      return exitCodeOf(null, signals.signal)
    }

    // The paths are literal one by one rather than through GIT_LITERAL_PATHSPECS, which the commit's hooks would inherit and read their own globs by.
    const commit = await git(['commit', '--only', '--cleanup=whitespace', '-m', message, '--', ...paths.map(path => `:(literal)${path}`)])

    if (commit.code !== 0) {
      await unstage(paths)

      const refusal = `git commit failed, the paths were unstaged:\n${(commit.stderr + commit.stdout).trim()}`

      if (values.json === true)
        fail(refusal, 1)

      printError('gc', refusal)

      return 1
    }

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
      console.log([head, ...lines.filter(Boolean).map(fileLine)].join('\n'))
    }

    return signals.signal === undefined ? 0 : exitCodeOf(null, signals.signal)
  }
  finally {
    signals.release()
  }
}

process.exitCode = await runMain({ name: 'gc', run: main })
