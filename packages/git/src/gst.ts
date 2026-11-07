#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Repo } from './repos'
import type { Change, Status } from './status'
import process from 'node:process'
import { fail, jsonOption, paint, parse, printJson, role, runMain, table, watching, watchOption, wholeNumber, withoutWatch } from '@kaynooo/cli-kit'
import { letter } from './colour'
import { git } from './git'
import { branchOf, changesOf, reposOf, repoState, trackingOf } from './repos'
import { parseStatus, summary } from './status'

const USAGE = `gst [-n N]: the repository's branch, upstream, changed files and HEAD in one line, then the changed paths by staged, unstaged and untracked

gst --repos [dir]... lists every repository at and below the current one's toplevel (or below each dir given, the current directory outside a repository), four levels down, past node_modules, vendor, dist and hidden folders: one line each with its path, branch, how it stands against its upstream as of the last fetch, and the files left to commit.`
const EXITS: ExitRow[] = [[0, 'it printed the status'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  limit: { type: 'string', short: 'n', description: 'add the last N commits as <sha7> <title>' },
  log: { type: 'string', short: 'l', description: 'the former spelling of --limit' },
  repos: { type: 'boolean', short: 'r', description: 'one line for each repository nested below, the current one included', conflicts: ['limit', 'log'] },
  watch: watchOption('the status'),
  json: jsonOption('{branch, oid, upstream, ahead, behind, head, staged, unstaged, untracked, conflicted, commits}; with --repos an array of them, each with its path and no commits, a repository git cannot read being {path, error}'),
} as const

type Commit = string[]

// The status as --json prints it, `commits` left out when none were asked for.
function jsonOf(status: Status, head: { sha: string, title: string } | null, commits?: Commit[]) {
  return {
    branch: status.branch,
    oid: status.oid,
    upstream: status.upstream,
    ahead: status.aheadBehind?.ahead ?? null,
    behind: status.aheadBehind?.behind ?? null,
    head,
    staged: status.changes.filter(change => change.index !== '.').map(({ index, path, from }) => ({ status: index, path, ...(from === undefined ? {} : { from }) })),
    unstaged: status.changes.filter(change => change.worktree !== '.').map(({ worktree, path }) => ({ status: worktree, path })),
    untracked: status.untracked,
    conflicted: status.conflicted,
    ...commits === undefined ? {} : { commits: commits.map(([commitSha = '', commitTitle = '']) => ({ sha: commitSha, title: commitTitle })) },
  }
}

async function listRepos(roots: string[], json: boolean): Promise<number> {
  const dirs = await reposOf(roots)

  if (dirs.length === 0)
    fail(`no git repository at or below ${roots.length === 0 ? 'the current directory' : roots.join(', ')}`)

  const repos = await Promise.all(dirs.map(repoState))

  if (json) {
    printJson(repos.map(({ path, status, head }) => status === null ? { path, error: 'git could not read it' } : { path, ...jsonOf(status, head) }))

    return 0
  }

  const dim = paint(process.stdout).dim
  const cells = (repo: Repo): string[] => {
    if (repo.status === null)
      return [role('path', process.stdout)(repo.path), '', '', 'git could not read it']

    const changes = changesOf(repo.status)

    return [role('path', process.stdout)(repo.path), branchOf(repo.status), trackingOf(repo.status), changes === 'clean' ? dim(changes) : changes]
  }

  console.log(table(repos.map(cells)))

  return 0
}

function group(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [paint(process.stdout).bold(`${title}:`), ...lines.map(line => `  ${line}`)]
}

function staged({ index, from, path }: Change): string {
  return `${letter(index)} ${from === undefined ? '' : `${from} -> `}${path}`
}

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { exits: EXITS, positionals: ['[dir]...'], replaces: 'git status --short, git log --oneline and a git -C <repo> status per nested repository', examples: ['gst', ['gst -n 5', 'with the last five commits'], ['gst --repos', 'the repositories nested in this one']] })

  if (parsed.positionals.length > 0 && parsed.values.repos !== true)
    fail(`gst takes dirs with --repos alone\n\n${USAGE}`)

  if (parsed.values.watch !== undefined)
    return watching(parsed.values.watch, async () => main(withoutWatch(argv)))

  if (parsed.values.repos === true)
    return listRepos(parsed.positionals, parsed.values.json === true)

  if (parsed.values.limit !== undefined && parsed.values.log !== undefined)
    fail('--limit and --log are the same flag, give one')

  const asked = parsed.values.limit ?? parsed.values.log
  const count = asked === undefined ? 0 : wholeNumber(asked, 'limit', 1)
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

    printJson(jsonOf(status, sha === undefined ? null : { sha, title: title ?? '' }, commits))

    return 0
  }

  const lines = [
    summary(status, head.code === 0 ? head.stdout : ''),
    ...group('staged', status.changes.filter(change => change.index !== '.').map(staged)),
    ...group('unstaged', status.changes.filter(change => change.worktree !== '.').map(change => `${letter(change.worktree)} ${change.path}`)),
    ...group('untracked', status.untracked.map(file => paint(process.stdout).dim(file))),
    ...group('conflicted', status.conflicted.map(file => paint(process.stdout).red(file))),
    ...group('commits', commits.map(([commitSha = '', commitTitle = '']) => `${role('id', process.stdout)(commitSha)} ${commitTitle}`)),
  ]

  console.log(lines.join('\n'))

  return 0
}

process.exitCode = await runMain({ name: 'gst', run: main })
