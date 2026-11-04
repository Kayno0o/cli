#!/usr/bin/env -S bun --no-env-file

import type { Change } from './status'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, runMain, wholeNumber } from '@kaynooo/cli-kit'
import { git } from './git'
import { parseStatus, summary } from './status'

const USAGE = 'gst [--log N]: the repository\'s branch, upstream, changed files and HEAD in one line, then the changed paths by staged, unstaged and untracked\n\nExits 0 when it printed the status, 2 outside a git repository or on a usage error.'

const OPTIONS = {
  log: { type: 'string', short: 'l', description: 'add the last N commits as <sha7> <title>' },
  json: jsonOption('{branch, oid, upstream, ahead, behind, head, staged, unstaged, untracked, conflicted, commits}'),
} as const

function group(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:`, ...lines.map(line => `  ${line}`)]
}

function staged({ index, from, path }: Change): string {
  return `${index} ${from === undefined ? '' : `${from} -> `}${path}`
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { replaces: 'git status --short and git log --oneline', examples: ['gst', ['gst --log 5', 'with the last five commits']] })

  if (parsed.positionals.length > 0)
    fail(`gst takes no paths\n\n${USAGE}`)

  const count = parsed.values.log === undefined ? 0 : wholeNumber(parsed.values.log, 'log', 1)
  const [read, head, log] = await Promise.all([
    git(['status', '--porcelain=v2', '--branch']),
    git(['log', '-1', '--format=%h%x00%s']),
    count === 0 ? undefined : git(['log', `-${count}`, '--format=%h%x00%s']),
  ])
  const status = read.code === 0 ? parseStatus(read.stdout) : null

  if (status === null)
    fail(read.stderr.trim() || 'not inside a git repository')

  const commits = log?.code === 0 ? log.stdout.trimEnd().split('\n').filter(Boolean).map(line => line.split('\0')) : []

  if (parsed.values.json === true) {
    const [sha, title] = head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim().split('\0') : []

    printJson({
      branch: status.branch,
      oid: status.oid,
      upstream: status.upstream,
      ahead: status.aheadBehind?.ahead ?? null,
      behind: status.aheadBehind?.behind ?? null,
      head: sha === undefined ? null : { sha, title: title ?? '' },
      staged: status.changes.filter(change => change.index !== '.').map(({ index, path, from }) => ({ status: index, path, ...(from === undefined ? {} : { from }) })),
      unstaged: status.changes.filter(change => change.worktree !== '.').map(({ worktree, path }) => ({ status: worktree, path })),
      untracked: status.untracked,
      conflicted: status.conflicted,
      commits: commits.map(([commitSha = '', commitTitle = '']) => ({ sha: commitSha, title: commitTitle })),
    })

    return 0
  }

  const lines = [
    summary(status, head.code === 0 ? head.stdout : ''),
    ...group('staged', status.changes.filter(change => change.index !== '.').map(staged)),
    ...group('unstaged', status.changes.filter(change => change.worktree !== '.').map(change => `${change.worktree} ${change.path}`)),
    ...group('untracked', status.untracked),
    ...group('conflicted', status.conflicted),
    ...group('commits', commits.map(parts => parts.join(' '))),
  ]

  console.log(lines.join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gst', run: main })
