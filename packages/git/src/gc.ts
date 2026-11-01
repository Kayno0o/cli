#!/usr/bin/env bun

import process from 'node:process'
import { fail, parse, runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { git } from './git'
import { commitMessageViolation, RULE, TICKET } from './message'

const USAGE = 'gc <title> [-m <line>]... [--ticket <line>]... -- <path>...: commits exactly the paths given, its message checked before anything is staged'

const OPTIONS = {
  message: { type: 'string', short: 'm', multiple: true, description: 'a line on what changed, at most two' },
  ticket: { type: 'string', multiple: true, description: 'a ticket line, `#<n> - <title>` (`owner/repo#<n> - <title>` across repositories) copied verbatim from the ticket' },
} as const

const RENAME = /^[RC]\d*$/

// The message as git will store it: the title, the description lines, then the ticket lines, each block after a blank line.
function messageOf(title: string, lines: string[], tickets: string[]): string {
  return [title, lines.join('\n'), tickets.join('\n')].filter(block => block !== '').join('\n\n')
}

async function checked(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await git(args)

  if (code !== 0)
    fail(`git ${args[0]} failed, nothing committed:\n${stderr.trim()}`, 1)

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
  const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0

  await git(hasHead ? ['reset', '-q', '--', ...paths] : ['rm', '-r', '-q', '--cached', '--', ...paths])
}

function fileLine(line: string): string {
  const [letter = '', from = '', to] = line.split('\t')

  return RENAME.test(letter) ? `  ${letter[0]} ${from} -> ${to}` : `  ${letter} ${from}`
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { rest: true })

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

  const changed = await Promise.all(paths.map(async path => (await checked(['status', '--porcelain', '--untracked-files=all', '--', path])) !== ''))
  const unchanged = paths.filter((_, i) => changed[i] !== true)

  if (unchanged.length > 0)
    fail(`nothing staged: no change to commit in ${unchanged.join(', ')} (unchanged, ignored or missing)`, 1)

  const others = await stagedElsewhere(paths)

  if (others.length > 0)
    fail(`nothing staged: the index already holds ${others.join(', ')}, which this commit would carry along; unstage them or name them too`, 1)

  await checked(['add', '--', ...paths])

  const commit = await git(['commit', '--cleanup=whitespace', '-m', message])

  if (commit.code !== 0) {
    await unstage(paths)
    console.error(`gc: git commit failed, the paths were unstaged:\n${(commit.stderr + commit.stdout).trim()}`)

    return 1
  }

  const files = await checked(['show', '--format=%h %s', '--name-status', '-M', 'HEAD'])
  const [head = '', ...lines] = files.trimEnd().split('\n')

  console.log([head, ...lines.filter(Boolean).map(fileLine)].join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gc', version, run: main })
