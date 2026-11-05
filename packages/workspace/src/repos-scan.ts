import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { pool, runCommand } from '@kaynooo/cli-kit'

export const MAX_DEPTH = 3
export const CONCURRENCY = 8
// Git calls in flight at once for the packages of one repository, on top of the repositories read together.
const PACKAGE_CONCURRENCY = 4
const GIT_MS = 10_000
const FETCH_MS = 30_000
const AHEAD_BEHIND = /\+(\d+) -(\d+)/
const PACKAGE_TAG = /^(.+)-v\d/

export interface PackageRelease {
  name: string
  tag: string
  unreleased: number
}

export interface RepoState {
  name: string
  path: string
  branch: string
  upstream: string | null
  dirty: number
  ahead: number | null
  behind: number | null
  worktrees: number
  tag: string | null
  unreleased: number | null
  packages: PackageRelease[]
  // The fetch was asked for and git failed or timed out, so the counts are older than asked.
  fetchFailed: boolean
  // `git status` failed or timed out, so the branch and the counts are unknown rather than clean.
  unreadable: boolean
}

export const REASONS = ['dirty', 'unpushed', 'unreleased', 'behind'] as const

export type Reason = (typeof REASONS)[number]

export function reasonsOf(repo: RepoState): Reason[] {
  const reasons: Reason[] = []

  if (repo.dirty > 0)
    reasons.push('dirty')

  if ((repo.ahead ?? 0) > 0)
    reasons.push('unpushed')

  if ((repo.behind ?? 0) > 0)
    reasons.push('behind')

  if ((repo.unreleased ?? 0) > 0)
    reasons.push('unreleased')

  return reasons
}

// The repository folders under `root`, three levels deep at most; the walk stops at a `.git` (a folder or a linked worktree's file) and skips `node_modules`, hidden folders and the names in `skip`.
export async function findRepos(root: string, skip: ReadonlySet<string>): Promise<string[]> {
  if (existsSync(join(root, '.git')))
    return [root]

  const found: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    let entries

    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.') || skip.has(entry.name))
        continue

      const path = join(dir, entry.name)

      if (existsSync(join(path, '.git')))
        found.push(path)
      else if (depth < MAX_DEPTH)
        await walk(path, depth + 1)
    }
  }

  await walk(root, 1)

  return found
}

// Git's trimmed stdout, or undefined when it fails or outlives its timeout.
async function read(path: string, args: string[], timeoutMs = GIT_MS): Promise<string | undefined> {
  try {
    const ran = await runCommand(['git', '--no-optional-locks', ...args], { cwd: path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs })

    return ran.code === 0 && !ran.timedOut ? ran.text.trim() : undefined
  }
  catch {
    return undefined
  }
}

async function commitsSince(path: string, tag: string, folder?: string): Promise<number> {
  const count = await read(path, ['rev-list', '--count', `${tag}..HEAD`, ...(folder === undefined ? [] : ['--', folder])])

  return Number(count ?? 0)
}

// Per package folder with `<folder>-v*` tags: the commits touching the folder since its latest tag. Empty for a repository that does not tag per folder.
async function packageReleases(path: string): Promise<PackageRelease[]> {
  const names = new Set<string>()

  for (const tag of (await read(path, ['tag', '--list']) ?? '').split('\n')) {
    const name = PACKAGE_TAG.exec(tag)?.[1]

    if (name !== undefined)
      names.add(name)
  }

  const releases = await pool([...names].toSorted(), PACKAGE_CONCURRENCY, async (name): Promise<PackageRelease | undefined> => {
    const folder = [join('packages', name), name].find(candidate => existsSync(join(path, candidate)))
    const tag = folder === undefined ? undefined : await read(path, ['describe', '--tags', '--abbrev=0', '--match', `${name}-v*`])

    return folder !== undefined && tag !== undefined && tag !== '' ? { name, tag, unreleased: await commitsSince(path, tag, folder) } : undefined
  })

  return releases.filter(release => release !== undefined)
}

export async function inspect(path: string, fetch: boolean): Promise<RepoState> {
  const fetched = fetch ? await read(path, ['fetch', '--quiet'], FETCH_MS) : ''
  const [status, worktrees, packages] = await Promise.all([
    read(path, ['status', '--porcelain=v2', '--branch']),
    read(path, ['worktree', 'list', '--porcelain']),
    packageReleases(path),
  ])
  const state: RepoState = { name: basename(path), path, branch: '?', upstream: null, dirty: 0, ahead: null, behind: null, worktrees: 0, tag: null, unreleased: null, packages, fetchFailed: fetched === undefined, unreadable: status === undefined }

  for (const line of (status ?? '').split('\n')) {
    if (line.startsWith('# branch.head '))
      state.branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.upstream '))
      state.upstream = line.slice('# branch.upstream '.length)
    else if (line.startsWith('# branch.ab '))
      [state.ahead, state.behind] = AHEAD_BEHIND.exec(line)?.slice(1).map(Number) as [number, number]
    else if (line !== '' && !line.startsWith('#'))
      state.dirty++
  }

  state.worktrees = Math.max(0, (worktrees ?? '').split('\n').filter(line => line.startsWith('worktree ')).length - 1)

  if (packages.length > 0) {
    state.unreleased = packages.reduce((sum, release) => sum + release.unreleased, 0)
  }
  else {
    const tag = await read(path, ['describe', '--tags', '--abbrev=0'])

    if (tag !== undefined && tag !== '') {
      state.tag = tag
      state.unreleased = await commitsSince(path, tag)
    }
  }

  return state
}

// Why a repository must not be pulled, undefined when a fast-forward onto its upstream is safe: clean, on a branch, with an upstream it is only behind.
export function pullBlocker(repo: RepoState): string | undefined {
  if (repo.unreadable)
    return 'unreadable'

  if (repo.fetchFailed)
    return 'fetch failed'

  if (repo.branch === '(detached)')
    return 'detached HEAD'

  if (repo.upstream === null)
    return 'no upstream'

  if (repo.dirty > 0)
    return `${repo.dirty} dirty ${repo.dirty === 1 ? 'file' : 'files'}`

  return (repo.ahead ?? 0) > 0 ? `diverged, ${repo.ahead} ahead` : undefined
}

function firstLine(text: string): string {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}

// Moves the current branch to its upstream as a fast-forward, which git refuses for anything else; answers git's complaint, undefined when it worked.
export async function fastForward(path: string): Promise<string | undefined> {
  try {
    const ran = await runCommand(['git', '--no-optional-locks', 'merge', '--ff-only', '--quiet', '@{upstream}'], { cwd: path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: GIT_MS })

    if (ran.timedOut)
      return 'timed out'

    return ran.code === 0 ? undefined : firstLine(ran.text.trim()) || `exit ${ran.code}`
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
