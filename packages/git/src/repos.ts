import type { Dirent } from 'node:fs'
import type { Status } from './status'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { git } from './git'
import { parseStatus } from './status'

// Folders a repo is never nested in: dependencies, build output, and hidden ones such as a container's data.
const SKIPPED = new Set(['node_modules', 'vendor', 'dist'])
const DEPTH = 4

/** One repository found and how it stands; `status` is null when git could not read it. */
export interface Repo {
  // Relative to the current directory, `.` for it.
  path: string
  dir: string
  status: Status | null
  head: { sha: string, title: string } | null
}

/** The repositories at and below `root`: a folder holding `.git`, a file for a worktree or a submodule included, walked `depth` levels down; symlinks are not followed. */
export async function reposUnder(root: string, depth = DEPTH): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string, left: number): Promise<void> {
    let entries: Dirent[]

    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    if (entries.some(entry => entry.name === '.git'))
      found.push(dir)

    if (left === 0)
      return

    await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)).map(async entry => walk(join(dir, entry.name), left - 1)))
  }

  await walk(resolve(root), depth)

  return found.sort()
}

/** The folder git takes for the repository holding `dir`, undefined outside one. */
export async function toplevelOf(dir: string): Promise<string | undefined> {
  const read = await git(['-C', dir, 'rev-parse', '--show-toplevel'])

  return read.code === 0 ? read.stdout.trim() : undefined
}

/** The repositories below each root, each once: the current repository's toplevel when none is given, the current directory outside one. */
export async function reposOf(roots: string[]): Promise<string[]> {
  const starts = roots.length > 0 ? roots : [await toplevelOf('.') ?? process.cwd()]
  const found = await Promise.all(starts.map(async root => reposUnder(root)))

  return [...new Set(found.flat())].sort()
}

export async function repoState(dir: string): Promise<Repo> {
  const [read, log] = await Promise.all([git(['-C', dir, 'status', '--porcelain=v2', '--branch']), git(['-C', dir, 'log', '-1', '--format=%h%x00%s'])])
  const [sha, title = ''] = log.code === 0 && log.stdout.trim() !== '' ? log.stdout.trim().split('\0') : []

  return { path: relative(process.cwd(), dir) || '.', dir, status: read.code === 0 ? parseStatus(read.stdout) : null, head: sha === undefined ? null : { sha, title } }
}

/** How the branch stands against its upstream, in a few words. */
export function trackingOf(status: Status): string {
  if (status.upstream === null)
    return 'no upstream'

  if (status.aheadBehind === null)
    return 'upstream gone'

  const { ahead, behind } = status.aheadBehind
  const parts = [ahead > 0 ? `${ahead} ahead` : '', behind > 0 ? `${behind} behind` : ''].filter(Boolean)

  return parts.length === 0 ? 'up to date' : parts.join(', ')
}

/** The files left to commit, `clean` when there are none. */
export function changesOf(status: Status): string {
  const { changes, untracked, conflicted } = status
  const parts = [changes.length > 0 ? `${changes.length} changed` : '', untracked.length > 0 ? `${untracked.length} untracked` : '', conflicted.length > 0 ? `${conflicted.length} conflicted` : ''].filter(Boolean)

  return parts.length === 0 ? 'clean' : parts.join(', ')
}

export function branchOf(status: Status): string {
  return status.branch === '(detached)' ? `detached at ${status.oid.slice(0, 7)}` : status.branch
}

/** The repositories a command works on: those below the dirs with `all`, else the toplevel of each dir (the current one by default); ends the command outside a repository. */
export async function dirsOf(positionals: string[], all: boolean): Promise<string[]> {
  const asked = positionals.length > 0 ? positionals : ['.']
  let dirs: string[]

  if (all) {
    dirs = await reposOf(positionals)
  }
  else {
    const found = await Promise.all(asked.map(async dir => toplevelOf(dir)))

    if (found.includes(undefined))
      fail(`not inside a git repository: ${asked.filter((_, at) => found[at] === undefined).join(', ')}`)

    dirs = [...new Set(found as string[])]
  }

  if (dirs.length === 0)
    fail(`no git repository at or below ${positionals.length === 0 ? 'the current directory' : positionals.join(', ')}`)

  return dirs
}
