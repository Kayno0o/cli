#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { SyncResult } from './sync'
import process from 'node:process'
import { jsonOption, marked, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { dirsOf, repoState } from './repos'
import { sync } from './sync'

const USAGE = `gf [dir]...: fetches with prune and fast-forwards the current branch onto its upstream, saying what came in

A branch that has diverged from its upstream, or a working tree the fast-forward would overwrite, is refused and left as it was: nothing is merged or rebased. A detached HEAD, a branch with no upstream and one whose upstream is gone are fetched only.
--repos does every repository at and below the current one's toplevel, or below each dir given, the way gst --repos lists them, one after another.`

const EXITS: ExitRow[] = [[0, 'every repository was fetched, and fast-forwarded when it could be'], [1, 'a fetch failed, a branch has diverged or a fast-forward was refused'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  'repos': { type: 'boolean', short: 'r', description: 'every repository nested below too' },
  'no-pull': { type: 'boolean', description: 'fetch only, saying how far behind the branch is' },
  'json': jsonOption('one {path, branch, upstream, commits, outcome, reason?} per repository, outcome being updated, current, fetched, skipped or refused'),
} as const

function line(result: SyncResult): string[] {
  const { dim } = paint(process.stdout)
  const count = `${result.commits} ${result.commits === 1 ? 'commit' : 'commits'}`
  const said = {
    updated: () => marked('ok', `${result.branch} <- ${result.upstream}, ${count}`, process.stdout),
    current: () => dim(`${result.branch} up to date`),
    fetched: () => `${result.branch} is ${result.commits} behind ${result.upstream}`,
    skipped: () => dim(`${result.branch ?? ''} ${result.reason ?? 'skipped'}`.trim()),
    refused: () => marked('problem', `${result.branch === null ? '' : `${result.branch}: `}${result.reason ?? 'refused'}`, process.stdout),
  }[result.outcome]

  return [role('path', process.stdout)(result.path), said()]
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['[dir]...'], exits: EXITS, replaces: 'git fetch --prune, git pull --ff-only and a git -C <repo> pull per nested repository', examples: ['gf', ['gf --repos', 'every repository nested in this one'], ['gf --no-pull', 'fetch and say how far behind the branch is']] })
  const repos = await Promise.all((await dirsOf(positionals, values.repos === true)).map(repoState))
  const results: SyncResult[] = []
  const progress = progressLine()

  // One repository at a time, so a passphrase asks one question at a time.
  for (const [at, repo] of repos.entries()) {
    progress.update(repos.length > 1 ? { step: `fetching ${repo.path}`, done: at, total: repos.length, unit: 'repositories' } : { step: `fetching ${repo.path}` })
    results.push(await sync(repo, { pull: values['no-pull'] !== true }))
  }

  progress.stop()

  if (values.json === true)
    printJson(results)
  else
    console.log(table(results.map(line)))

  return results.some(result => result.outcome === 'refused') ? 1 : 0
}

process.exitCode = await runMain({ name: 'gf', run: main })
