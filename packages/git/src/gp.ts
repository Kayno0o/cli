#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Repo } from './repos'
import process from 'node:process'
import { jsonOption, marked, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { git } from './git'
import { dirsOf, repoState } from './repos'

const USAGE = `gp [dir]...: pushes the current branch of the repository, or of each dir's, when it is ahead of its upstream as of the last fetch or has none yet, the latter with -u to origin (the only remote when there is no origin)

--repos pushes every repository at and below the current one's toplevel, or below each dir given, the way gst --repos lists them. A detached HEAD, a branch with nothing to push and a repository with no remote are skipped, saying so; the pushes run one after another.
What follows -- goes to every git push as is (gp -- --tags, gp -- --force-with-lease), and a branch with nothing ahead is then pushed too.`

const EXITS: ExitRow[] = [[0, 'every push went through, or there was nothing to push'], [1, 'a push was refused or a repository could not be read'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  'repos': { type: 'boolean', short: 'r', description: 'every repository nested below too' },
  'dry-run': { type: 'boolean', description: 'say what would be pushed, pushing nothing' },
  'json': jsonOption('one {path, branch, remote, commits, outcome, reason?} per repository, outcome being pushed, would-push, skipped or refused'),
} as const

type Outcome = 'pushed' | 'would-push' | 'skipped' | 'refused'

interface Result {
  path: string
  branch: string | null
  // Where the branch goes, `origin/main`; null when nothing is pushed.
  remote: string | null
  // The commits the push sends, as of the last fetch.
  commits: number | null
  outcome: Outcome
  reason?: string
}

const GIT_FAILURE = /^(?: ! |error: |fatal: )/

// The line of git's output saying why a push failed.
function whyRefused(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trimEnd()).filter(Boolean)

  return (lines.find(line => GIT_FAILURE.test(line)) ?? lines.at(-1) ?? 'git push failed').trim()
}

// The remote a branch with no upstream goes to: origin, else the only remote there is.
async function remoteFor(dir: string): Promise<string | undefined> {
  const remotes = (await git(['-C', dir, 'remote'])).stdout.split('\n').filter(Boolean)

  if (remotes.includes('origin'))
    return 'origin'

  return remotes.length === 1 ? remotes[0] : undefined
}

// The commits of the branch no remote has yet.
async function unpushed(dir: string, branch: string): Promise<number | null> {
  const count = await git(['-C', dir, 'rev-list', '--count', branch, '--not', '--remotes'])

  return count.code === 0 ? Number(count.stdout.trim()) : null
}

async function push(repo: Repo, { dryRun, extra }: { dryRun: boolean, extra: string[] }): Promise<Result> {
  const { path, dir, status } = repo
  const skipped = (reason: string, branch: string | null = null): Result => ({ path, branch, remote: null, commits: null, outcome: 'skipped', reason })

  if (status === null)
    return { path, branch: null, remote: null, commits: null, outcome: 'refused', reason: 'git could not read it' }

  const { branch, upstream, aheadBehind } = status

  if (branch === '(detached)')
    return skipped('detached HEAD')

  let args: string[]
  let remote: string
  let commits: number | null

  if (upstream === null) {
    const name = await remoteFor(dir)

    if (name === undefined)
      return skipped('no upstream, and no origin remote to push to', branch)

    args = ['push', '-u', ...extra, name, branch]
    remote = `${name}/${branch}`
    commits = await unpushed(dir, branch)
  }
  else {
    // An upstream gone is pushed again, git saying where.
    if (aheadBehind !== null && aheadBehind.ahead === 0 && extra.length === 0)
      return skipped('nothing to push', branch)

    args = ['push', ...extra]
    remote = upstream
    commits = aheadBehind?.ahead ?? await unpushed(dir, branch)
  }

  if (dryRun)
    return { path, branch, remote, commits, outcome: 'would-push' }

  const pushed = await git(['-C', dir, ...args])

  return pushed.code === 0 ? { path, branch, remote, commits, outcome: 'pushed' } : { path, branch, remote, commits, outcome: 'refused', reason: whyRefused(pushed.stderr) }
}

function line(result: Result): string[] {
  const { dim } = paint(process.stdout)
  const sent = result.commits === null ? '' : `, ${result.commits} ${result.commits === 1 ? 'commit' : 'commits'}`
  const what = `${result.branch} -> ${result.remote}${sent}`
  const said = {
    'pushed': () => marked('ok', `pushed ${what}`, process.stdout),
    'would-push': () => `would push ${what}`,
    'skipped': () => dim(result.reason ?? 'skipped'),
    'refused': () => marked('problem', `${result.branch === null ? '' : `${result.branch}: `}${result.reason ?? 'refused'}`, process.stdout),
  }[result.outcome]

  return [role('path', process.stdout)(result.path), said()]
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals, rest = [] } = parse(argv, USAGE, OPTIONS, { positionals: ['[dir]...'], rest: true, exits: EXITS, replaces: 'git push, git push -u origin <branch> and a git -C <repo> push per nested repository', examples: ['gp', ['gp --repos', 'every repository nested in this one'], ['gp --repos --dry-run', 'what would go out'], ['gp . ../other', 'this repository and a sibling'], ['gp -- --force-with-lease', 'flags for git push']] })
  const dirs = await dirsOf(positionals, values.repos === true)
  const repos = await Promise.all(dirs.map(repoState))
  const results: Result[] = []

  // The count shows only with several repositories to push.
  const progress = progressLine()

  // One push at a time, so a passphrase or a hook asks one question at a time.
  for (const [at, repo] of repos.entries()) {
    progress.update(repos.length > 1 ? { step: `pushing ${repo.path}`, done: at, total: repos.length, unit: 'repositories' } : { step: `pushing ${repo.path}` })
    results.push(await push(repo, { dryRun: values['dry-run'] === true, extra: rest }))
  }

  progress.stop()

  if (values.json === true)
    printJson(results)
  else
    console.log(table(results.map(line)))

  return results.some(result => result.outcome === 'refused') ? 1 : 0
}

process.exitCode = await runMain({ name: 'gp', run: main })
