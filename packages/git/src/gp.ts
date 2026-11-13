#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Repo } from './repos'
import process from 'node:process'
import { jsonOption, marked, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { askpass } from '@kaynooo/cli-kit/askpass'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { git } from './git'
import { dirsOf, repoState } from './repos'

const USAGE = `gp [dir]...: pushes the current branch of the repository, or of each dir, when it is ahead of its upstream or has none yet

--branch pushes that local branch instead, to its upstream or with -u to origin, whichever branch is checked out; given several times, each is pushed, and a repository without it is skipped.
--repos pushes every repository at and below the current one's toplevel, or below each dir given, the way gst --repos lists them. A detached HEAD, a branch with nothing to push and a repository with no remote are skipped, saying so; the pushes run one after another.
What follows -- goes to every git push as is (gp -- --tags, gp -- --force-with-lease), and a branch with nothing ahead is then pushed too.`

const EXITS: ExitRow[] = [[0, 'every push went through, or there was nothing to push'], [1, 'a push was refused or a repository could not be read'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  'branch': { type: 'string', short: 'b', multiple: true, description: 'push this local branch instead of the current one' },
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

// A branch to push and how it stands against its upstream.
interface Target {
  branch: string
  // `origin/main`, null when it has none.
  upstream: string | null
  // The commits ahead of the upstream, null when the upstream is gone.
  ahead: number | null
  // What follows the remote in git push: nothing for the current branch, which a bare git push sends.
  refspec: string[]
}

// `ahead 2, behind 1` as git's upstream:track words it.
const AHEAD = /ahead (\d+)/

// A branch named with --branch, undefined when the repository has no such local branch.
async function namedTarget(dir: string, branch: string): Promise<Target | undefined> {
  const read = await git(['-C', dir, 'for-each-ref', '--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)', `refs/heads/${branch}`])
  const line = read.stdout.trim()

  if (read.code !== 0 || line === '')
    return undefined

  const [upstream = '', remote = '', ref = '', track = ''] = line.split('\0')

  if (upstream === '')
    return { branch, upstream: null, ahead: null, refspec: [] }

  return { branch, upstream, ahead: track === 'gone' ? null : Number(AHEAD.exec(track)?.[1] ?? 0), refspec: [remote, `${branch}:${ref}`] }
}

async function push(repo: Repo, asked: string | undefined, { dryRun, extra, env }: { dryRun: boolean, extra: string[], env?: Record<string, string | undefined> | undefined }): Promise<Result> {
  const { path, dir, status } = repo
  const skipped = (reason: string, branch: string | null = null): Result => ({ path, branch, remote: null, commits: null, outcome: 'skipped', reason })

  if (status === null)
    return { path, branch: null, remote: null, commits: null, outcome: 'refused', reason: 'git could not read it' }

  let target: Target | undefined

  if (asked !== undefined) {
    target = await namedTarget(dir, asked)

    if (target === undefined)
      return skipped(`no branch ${asked}`, asked)
  }
  else {
    if (status.branch === '(detached)')
      return skipped('detached HEAD')

    target = { branch: status.branch, upstream: status.upstream, ahead: status.aheadBehind?.ahead ?? null, refspec: [] }
  }

  const { branch, upstream, ahead, refspec } = target
  let args: string[]
  let remote: string
  let commits: number | null

  if (upstream === null) {
    if ((await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0)
      return skipped('no commit yet, nothing to push', branch)

    const name = await remoteFor(dir)

    if (name === undefined)
      return skipped('no upstream, and no origin remote to push to', branch)

    args = ['push', '-u', ...extra, name, branch]
    remote = `${name}/${branch}`
    commits = await unpushed(dir, branch)
  }
  else {
    // An upstream gone is pushed again, git saying where.
    if (ahead === 0 && extra.length === 0)
      return skipped('nothing to push', branch)

    args = ['push', ...extra, ...refspec]
    remote = upstream
    commits = ahead ?? await unpushed(dir, branch)
  }

  if (dryRun)
    return { path, branch, remote, commits, outcome: 'would-push' }

  const pushed = await git(['-C', dir, ...args], env)

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
  const { values, positionals, rest = [] } = parse(argv, USAGE, OPTIONS, { positionals: ['[dir]...'], rest: true, exits: EXITS, replaces: 'git push, git push -u origin <branch> and a git -C <repo> push per nested repository', examples: ['gp', ['gp --repos', 'every repository nested in this one'], ['gp --repos --dry-run', 'what would go out'], ['gp . ../other', 'this repository and a sibling'], ['gp -b feature', 'a branch other than the current one'], ['gp -- --force-with-lease', 'flags for git push']] })
  const dirs = await dirsOf(positionals, values.repos === true)
  const repos = await Promise.all(dirs.map(repoState))
  const branches = values.branch ?? [undefined]
  const pushes = repos.flatMap(repo => branches.map(branch => ({ repo, branch })))
  const results: Result[] = []

  // The count shows only with several repositories to push.
  const progress = progressLine()
  const prompts = askpass(progress.pause)
  const env = prompts === undefined ? undefined : { ...process.env, ...prompts.env }

  try {
    // One push at a time, so a passphrase or a hook asks one question at a time.
    for (const [at, { repo, branch }] of pushes.entries()) {
      progress.update(pushes.length > 1 ? { step: `pushing ${repo.path}`, done: at, total: pushes.length, unit: 'pushes' } : { step: `pushing ${repo.path}` })
      results.push(await push(repo, branch, { dryRun: values['dry-run'] === true, extra: rest, env }))
    }
  }
  finally {
    prompts?.close()
    progress.stop()
  }

  if (values.json === true)
    printJson(results)
  else
    console.log(table(results.map(line)))

  return results.some(result => result.outcome === 'refused') ? 1 : 0
}

process.exitCode = await runMain({ name: 'gp', run: main })
