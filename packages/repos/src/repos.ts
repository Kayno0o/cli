#!/usr/bin/env bun

import type { RepoState } from './scan'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, oneOf, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { CONCURRENCY, findRepos, inspect, MAX_DEPTH, pool, REASONS, reasonsOf } from './scan'

const USAGE = `repos [options] [root]: the git repositories under root (~/Workspace by default) that need attention, with their branch, dirty files, ahead/behind their upstream, linked worktrees and commits since their latest tag

A repository with nothing to report is left out unless --all. A monorepo tagging its packages <folder>-v<version> counts the unreleased commits per package folder. The walk goes ${MAX_DEPTH} levels deep, stops at a .git and skips node_modules, hidden folders and the names in "skip" of ~/.config/kaynooo-cli/repos.json.

Ahead and behind are those of the last fetch unless --fetch refreshes the upstreams first, which reaches the remote.

Exits 0 when it listed the repositories, including when none needs attention, 2 on a usage error, an unreadable config or a root that is no folder.`

const OPTIONS = {
  all: { type: 'boolean', short: 'a', description: 'list the repositories with nothing to report too' },
  only: { type: 'string', choices: REASONS, description: 'only the repositories with this reason: dirty, unpushed, unreleased or behind' },
  fetch: { type: 'boolean', description: 'refresh the upstreams first (reaches the remote)' },
  json: jsonOption('[{name, path, branch, upstream, dirty, ahead, behind, worktrees, tag, unreleased, packages, reasons, fetchFailed, unreadable}]'),
} as const

async function skipped(): Promise<Set<string>> {
  const file = join(homedir(), '.config', 'kaynooo-cli', 'repos.json')

  if (!existsSync(file))
    return new Set()

  try {
    const config = await Bun.file(file).json() as { skip?: unknown }

    return new Set(Array.isArray(config.skip) ? config.skip.filter((name): name is string => typeof name === 'string') : [])
  }
  catch (error) {
    fail(`${file} does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function releasedCell(repo: RepoState): string {
  if (repo.packages.length > 0)
    return repo.packages.filter(release => release.unreleased > 0).map(release => `${release.name} ${release.unreleased}`).join(', ') || '-'

  return repo.tag === null || repo.unreleased === 0 ? '-' : `${repo.unreleased} since ${repo.tag}`
}

function row(repo: RepoState, shown: string): string[] {
  const tint = role('path', process.stdout)
  const ahead = repo.ahead ?? 0
  const behind = repo.behind ?? 0
  const sync = repo.upstream === null ? 'no upstream' : [ahead > 0 ? `+${ahead}` : '', behind > 0 ? `-${behind}` : ''].filter(Boolean).join(' ') || '-'

  return [tint(shown), repo.unreadable ? '? (unreadable)' : repo.branch, repo.dirty === 0 ? '-' : String(repo.dirty), sync, repo.worktrees === 0 ? '-' : String(repo.worktrees), releasedCell(repo)]
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[root]'], replaces: 'a cd, git status, git log and git tag loop over each repository of the workspace', examples: ['repos', 'repos ~/Workspace --only unreleased --fetch'] })
  const root = resolve(positionals[0] ?? join(homedir(), 'Workspace'))

  if (!existsSync(root) || !statSync(root).isDirectory())
    fail(`no folder ${root}`)

  const only = values.only === undefined ? undefined : oneOf(values.only, 'only', REASONS)
  const paths = await findRepos(root, await skipped())
  const states = await pool(paths, CONCURRENCY, async path => inspect(path, values.fetch === true))
  const kept = states.filter((repo) => {
    const reasons = reasonsOf(repo)

    return only === undefined ? values.all === true || reasons.length > 0 || repo.unreadable : reasons.includes(only)
  })

  if (values.json === true) {
    printJson(kept.map(repo => ({ ...repo, reasons: reasonsOf(repo) })))

    return 0
  }

  const label = role('label', process.stdout)

  if (kept.length === 0) {
    console.log(label(`nothing needs attention in ${states.length} repositories`))

    return 0
  }

  console.log(table([['repo', 'branch', 'dirty', 'ahead/behind', 'worktrees', 'unreleased'], ...kept.map(repo => row(repo, relative(root, repo.path) || repo.name))], { header: true, align: ['left', 'left', 'right', 'left', 'right', 'left'] }))

  const failed = kept.filter(repo => repo.fetchFailed).map(repo => repo.name)

  if (failed.length > 0)
    console.log(label(`fetch failed for ${failed.join(', ')}`))

  if (values.fetch !== true)
    console.log(label('ahead/behind as of the last fetch, --fetch refreshes them'))

  return 0
}

process.exitCode = await runMain({ name: 'repos', version, run: main })
