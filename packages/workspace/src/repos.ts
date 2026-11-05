import type { ExitRow } from '@kaynooo/cli-kit'
import type { RepoState } from './repos-scan'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, marked, oneOf, paint, parse, pool, printJson, role, table, takesControlCodes, userConfigReadPath } from '@kaynooo/cli-kit'
import { CONCURRENCY, fastForward, findRepos, inspect, MAX_DEPTH, pullBlocker, REASONS, reasonsOf } from './repos-scan'

const USAGE = `repos [options] [root]: the git repositories under root (~/Workspace by default) that need attention, with their branch, dirty files, ahead/behind their upstream, linked worktrees and commits since their latest tag

A repository with nothing to report is left out unless --all. A monorepo tagging its packages <folder>-v<version> counts the unreleased commits per package folder. The walk goes ${MAX_DEPTH} levels deep, stops at a .git and skips node_modules, hidden folders and the names in "skip" of ~/.config/kaynooo-cli/repos.json.

Ahead and behind are those of the last fetch unless --fetch refreshes the upstreams first, which reaches the remote.
--pull fetches, then fast-forwards the repositories listed that are clean, on a branch and only behind their upstream, and touches nothing else: a dirty, ahead, diverged or detached one is reported as skipped. A repository pulled is listed again as it now stands.
--path prints only the paths of the repositories listed, one per line, for xargs -d '\\n'.`

const EXITS: ExitRow[] = [[0, 'it listed the repositories, including when none needs attention'], [1, 'a fast-forward --pull attempted failed'], [2, 'a usage error, an unreadable config or a root that is no folder']]

const OPTIONS = {
  all: { type: 'boolean', short: 'a', description: 'list the repositories with nothing to report too' },
  only: { type: 'string', choices: REASONS, description: 'only the repositories with this reason: dirty, unpushed, unreleased or behind' },
  fetch: { type: 'boolean', description: 'refresh the upstreams first (reaches the remote)' },
  pull: { type: 'boolean', description: 'fetch, then fast-forward the clean repositories listed that are only behind their upstream (reaches the remote)' },
  path: { type: 'boolean', conflicts: ['json'], description: 'print only the paths of the repositories listed, one per line' },
  json: jsonOption('[{name, path, branch, upstream, dirty, ahead, behind, worktrees, tag, unreleased, packages, reasons, fetchFailed, unreadable}]'),
} as const

async function skipped(): Promise<Set<string>> {
  const file = userConfigReadPath('repos')

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

// Ahead in green, behind in red, both marked as diverged on a terminal, and no upstream dimmed.
export function syncCell(repo: RepoState, stream: { isTTY?: boolean } = process.stdout): string {
  const colors = paint(stream)
  const ahead = repo.ahead ?? 0
  const behind = repo.behind ?? 0

  if (repo.upstream === null)
    return colors.dim('no upstream')

  const parts = [ahead > 0 ? colors.green(`+${ahead}`) : '', behind > 0 ? colors.red(`-${behind}`) : ''].filter(Boolean)

  const diverged = takesControlCodes(stream) && ahead > 0 && behind > 0

  return parts.length === 0 ? colors.dim('-') : `${parts.join(' ')}${diverged ? colors.yellow(' diverged') : ''}`
}

const DEFAULT_BRANCHES = new Set(['main', 'master'])

// A branch other than the usual default one stands out, so a repository left on a feature branch is seen at a glance.
function branchCell(repo: RepoState): string {
  const colors = paint(process.stdout)

  if (repo.unreadable)
    return colors.red('? (unreadable)')

  if (repo.branch === '(detached)')
    return colors.yellow(repo.branch)

  return DEFAULT_BRANCHES.has(repo.branch) ? repo.branch : role('accent', process.stdout)(repo.branch)
}

function row(repo: RepoState, shown: string): string[] {
  const colors = paint(process.stdout)
  const tint = role('path', process.stdout)
  const unreleased = releasedCell(repo)

  return [
    tint(shown),
    branchCell(repo),
    repo.dirty === 0 ? colors.dim('-') : colors.yellow(String(repo.dirty)),
    syncCell(repo),
    repo.worktrees === 0 ? colors.dim('-') : String(repo.worktrees),
    unreleased === '-' ? colors.dim('-') : colors.cyan(unreleased),
  ]
}

export async function repos(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['[root]'], exits: EXITS, replaces: 'a cd, git status, git log and git tag loop over each repository of the workspace', examples: ['repos', 'repos ~/Workspace --only unreleased --fetch', ['repos --only behind --pull', 'fast-forward what is behind and clean'], ['repos --only dirty --path', 'the paths, for xargs']] })
  const root = resolve(positionals[0] ?? join(homedir(), 'Workspace'))

  if (!existsSync(root) || !statSync(root).isDirectory())
    fail(`no folder ${root}`)

  const only = values.only === undefined ? undefined : oneOf(values.only, 'only', REASONS)
  const paths = await findRepos(root, await skipped())
  const states = await pool(paths, CONCURRENCY, async path => inspect(path, values.fetch === true || values.pull === true))
  const keeps = (repo: RepoState) => {
    const reasons = reasonsOf(repo)

    return only === undefined ? values.all === true || reasons.length > 0 || repo.unreadable : reasons.includes(only)
  }
  let failedPulls = 0

  if (values.pull === true) {
    const log = values.json === true || values.path === true ? console.error : console.log

    for (const [index, repo] of states.entries()) {
      if (!keeps(repo) || (repo.behind ?? 0) === 0)
        continue

      const blocker = pullBlocker(repo)
      const refused = blocker === undefined ? await fastForward(repo.path) : undefined

      if (blocker !== undefined) {
        log(marked('note', `${repo.name} skipped`, process.stdout, blocker))
      }
      else if (refused !== undefined) {
        failedPulls++
        log(marked('problem', `${repo.name} not pulled`, process.stdout, refused))
      }
      else {
        log(marked('ok', `${repo.name} pulled`, process.stdout, `${repo.behind} ${repo.behind === 1 ? 'commit' : 'commits'}`))
        states[index] = await inspect(repo.path, false)
      }
    }
  }

  const kept = states.filter(keeps)

  if (values.path === true) {
    for (const repo of kept)
      console.log(repo.path)

    return failedPulls > 0 ? 1 : 0
  }

  if (values.json === true) {
    printJson(kept.map(repo => ({ ...repo, reasons: reasonsOf(repo) })))

    return failedPulls > 0 ? 1 : 0
  }

  const label = role('label', process.stdout)

  if (kept.length === 0) {
    console.log(label(`nothing needs attention in ${states.length} repositories`))

    return failedPulls > 0 ? 1 : 0
  }

  console.log(table([['repo', 'branch', 'dirty', 'ahead/behind', 'worktrees', 'unreleased'], ...kept.map(repo => row(repo, relative(root, repo.path) || repo.name))], { header: true, align: ['left', 'left', 'right', 'left', 'right', 'left'] }))

  const failed = kept.filter(repo => repo.fetchFailed).map(repo => repo.name)

  if (failed.length > 0)
    console.log(label(`fetch failed for ${failed.join(', ')}`))

  if (values.fetch !== true)
    console.log(label('ahead/behind as of the last fetch, --fetch refreshes them'))

  return failedPulls > 0 ? 1 : 0
}
