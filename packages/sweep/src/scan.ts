import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { runTool } from '@kaynooo/cli-kit'
import { pooled, sizeOf } from './size'

export const FOLDER_NAMES = new Set(['node_modules', '.nuxt', '.next', '.output', 'dist', 'build', '.turbo', '.svelte-kit', 'target'])
export const MAX_DEPTH = 3
export const PROJECT_CACHE_NAMES = new Set(['.turbo', '.nuxt', '.next', '.svelte-kit'])
// Exact paths under HOME, the only places outside the root that sweep reads or deletes.
export const GLOBAL_CACHES = ['.bun/install/cache', '.npm/_cacache', '.cache/pip', '.cache/uv', '.cache/ms-playwright', '.cache/puppeteer', '.cache/go-build', '.cache/typescript', '.cargo/registry']

export interface Entry {
  path: string
  kind: 'folder' | 'worktree' | 'cache'
  bytes: number
  // The repo's last commit in epoch milliseconds, undefined outside a repo or in an empty one.
  committedAt: number | undefined
  action: 'remove' | 'keep'
  // Why a worktree is kept.
  reason?: string
  // The repo a worktree is removed from.
  repo?: string
  // The node_modules a node_modules/.cache sits in, dropped when that node_modules is listed itself.
  inside?: string | undefined
}

export interface Skipped {
  path: string
  reason: string
}

interface Candidate {
  path: string
  kind: Entry['kind']
  inside?: string
  global?: true
}

export function isCachePath(path: string, home = homedir()): boolean {
  return GLOBAL_CACHES.some(cache => join(home, cache) === path) || (basename(path) === '.cache' && basename(dirname(path)) === 'node_modules')
}

export interface Found {
  candidates: Candidate[]
  skipped: Skipped[]
}

async function listing(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  }
  catch {
    return []
  }
}

async function addGlobalCaches(found: Found, home: string): Promise<void> {
  for (const cache of GLOBAL_CACHES) {
    const path = join(home, cache)

    try {
      const stat = await lstat(path)

      if (stat.isSymbolicLink())
        found.skipped.push({ path, reason: 'symlink' })
      else if (stat.isDirectory())
        found.candidates.push({ path, kind: 'cache', global: true })
    }
    catch {}
  }
}

// Walks `root` MAX_DEPTH levels down without entering a candidate, `.git` or a symlink, and returns the folders, caches and worktrees that look removable, a symlink bearing a candidate name being skipped instead; the global caches under `home` come along.
export async function findCandidates(root: string, home = homedir()): Promise<Found> {
  const found: Found = { candidates: [], skipped: [] }
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await listing(dir)

    for (const entry of entries) {
      const path = join(dir, entry.name)

      if (entry.name === '.git')
        continue

      if (entry.name === '.worktrees' || (entry.name === 'worktrees' && basename(dir) === '.claude')) {
        if (!entry.isDirectory()) {
          found.skipped.push({ path, reason: 'symlink' })

          continue
        }

        for (const worktree of await listing(path)) {
          if (worktree.isDirectory())
            found.candidates.push({ path: join(path, worktree.name), kind: 'worktree' })
          else if (worktree.isSymbolicLink())
            found.skipped.push({ path: join(path, worktree.name), reason: 'symlink' })
        }

        continue
      }

      if (FOLDER_NAMES.has(entry.name) && (entry.name !== 'target' || existsSync(join(dir, 'Cargo.toml')))) {
        if (entry.isSymbolicLink()) {
          found.skipped.push({ path, reason: 'symlink' })
        }
        else if (entry.isDirectory()) {
          found.candidates.push({ path, kind: PROJECT_CACHE_NAMES.has(entry.name) ? 'cache' : 'folder' })

          if (entry.name === 'node_modules') {
            const cache = (await listing(path)).find(inner => inner.name === '.cache')

            if (cache?.isSymbolicLink())
              found.skipped.push({ path: join(path, '.cache'), reason: 'symlink' })
            else if (cache?.isDirectory())
              found.candidates.push({ path: join(path, '.cache'), kind: 'cache', inside: path })
          }
        }

        continue
      }

      if (entry.isDirectory() && depth < MAX_DEPTH)
        await visit(path, depth + 1)
    }
  }

  await visit(root, 0)
  await addGlobalCaches(found, home)

  return found
}

async function realOf(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  }
  catch {
    return undefined
  }
}

const HEADS_PREFIX = /^refs\/heads\//
const TRAILING_SLASH = /\/$/

async function gitIn(cwd: string, args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  try {
    const { code, stdout, stderr } = await runTool(`git ${args.join(' ')}`, ['git', '-C', cwd, ...args], { timeoutMs: 30_000 })

    return { code, stdout: stdout.trim(), stderr }
  }
  catch (error) {
    return { code: -1, stdout: '', stderr: String(error) }
  }
}

// One lookup per key, the promise shared by every caller asking for it.
function memo<T>(make: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>()

  return async (key) => {
    let value = cache.get(key)

    if (value === undefined) {
      value = make(key)
      cache.set(key, value)
    }

    return value
  }
}

const NOT_A_REPO = /not a git repository/i

// Outside a repository is told apart from git failing, which must never read as "safe to delete".
const toplevelOf = memo(async (dir): Promise<{ top: string } | 'none' | 'failed'> => {
  const { code, stdout, stderr } = await gitIn(dir, ['rev-parse', '--show-toplevel'])

  if (code === 0 && stdout !== '')
    return { top: stdout }

  return NOT_A_REPO.test(stderr) ? 'none' : 'failed'
})

const lastCommitOf = memo(async (top) => {
  const { code, stdout } = await gitIn(top, ['log', '-1', '--format=%ct'])

  return code === 0 && stdout !== '' ? Number(stdout) * 1000 : undefined
})

// The checked-out branch of every worktree git knows for a repo, by real path; a detached one maps to undefined.
const worktreesOf = memo(async (repo) => {
  const { code, stdout } = await gitIn(repo, ['worktree', 'list', '--porcelain'])
  const branches = new Map<string, string | undefined>()

  if (code !== 0)
    return branches

  for (const block of stdout.split('\n\n')) {
    const lines = block.split('\n')
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)

    if (path !== undefined)
      branches.set(await realOf(path) ?? path, branch)
  }

  return branches
})

type Verdict = { skip: string } | { entry: Omit<Entry, 'bytes'> }

async function judgeFolder(path: string, kind: Entry['kind'], inside?: string): Promise<Verdict> {
  const parent = dirname(path)
  const name = basename(path)
  const located = await toplevelOf(parent)

  if (located === 'failed')
    return { skip: 'git failed' }

  if (existsSync(join(path, '.git')))
    return { skip: 'holds a git repository' }

  if (located === 'none')
    return name === 'node_modules' || inside !== undefined ? { entry: { path, kind, committedAt: undefined, action: 'remove', inside } } : { skip: 'not in a git repository' }

  const tracked = await gitIn(parent, ['ls-files', '--', name])

  if (tracked.code !== 0 || tracked.stdout !== '')
    return { skip: 'tracked by git' }

  if (name !== 'node_modules' && inside === undefined && (await gitIn(parent, ['check-ignore', '-q', '--', name])).code !== 0)
    return { skip: 'not ignored by git' }

  return { entry: { path, kind, committedAt: await lastCommitOf(located.top), action: 'remove', inside } }
}

// A worktree is removable only when it is clean and every commit of its branch is on another branch or a remote.
async function judgeWorktree(path: string): Promise<Verdict> {
  const located = await toplevelOf(dirname(path))

  if (located === 'failed')
    return { skip: 'git failed' }

  if (located === 'none')
    return { skip: 'not in a git repository' }

  const { top } = located

  const real = await realOf(path)
  const branches = await worktreesOf(top)

  if (real === undefined || !branches.has(real))
    return { skip: 'not a worktree of this repo' }

  const committedAt = await lastCommitOf(top)
  const keep = (reason: string): Verdict => ({ entry: { path, kind: 'worktree', committedAt, action: 'keep', reason, repo: top } })
  const branch = branches.get(real)

  if (branch === undefined)
    return keep('detached HEAD')

  const status = await gitIn(path, ['status', '--porcelain', '-z', '--ignored=matching'])

  if (status.code !== 0)
    return keep('status failed')

  const changes = status.stdout.split('\0').filter(line => line !== '')

  if (changes.some(line => !line.startsWith('!! ')))
    return keep('uncommitted changes')

  // git worktree remove deletes ignored files too (.env, local databases); only the regenerable build folders may go with it.
  if (changes.some(line => !line.endsWith('/') || !FOLDER_NAMES.has(basename(line.slice(3).replace(TRAILING_SLASH, '')))))
    return keep('ignored files (.env, local data) that removing would delete')

  // git strips the refs/heads/ prefix before matching an --exclude that applies to --branches.
  const unique = await gitIn(path, ['log', '--format=%h', branch, '--not', '--remotes', `--exclude=${branch.replace(HEADS_PREFIX, '')}`, '--branches'])

  if (unique.code !== 0)
    return keep('log failed')

  if (unique.stdout !== '')
    return keep(`${unique.stdout.split('\n').length} commits on no other branch or remote`)

  return { entry: { path, kind: 'worktree', committedAt, action: 'remove', repo: top } }
}

// A global cache is an exact allowlisted path found as a plain folder, so git has nothing to say about it.
async function judge(candidate: Candidate): Promise<Verdict> {
  if (candidate.global === true)
    return { entry: { path: candidate.path, kind: candidate.kind, committedAt: undefined, action: 'remove' } }

  return candidate.kind === 'worktree' ? judgeWorktree(candidate.path) : judgeFolder(candidate.path, candidate.kind, candidate.inside)
}

// Judges and sizes every candidate, the ones git forbids touching going to `skipped`.
export async function inspect({ candidates, skipped }: Found): Promise<{ entries: Entry[], skipped: Skipped[] }> {
  const entries: Entry[] = []
  const rejected = [...skipped]

  await pooled(candidates, 8, async (candidate) => {
    const verdict = await judge(candidate)

    if ('skip' in verdict)
      rejected.push({ path: candidate.path, reason: verdict.skip })
    else
      entries.push({ ...verdict.entry, bytes: await sizeOf(candidate.path) })
  })

  const listed = new Set(entries.filter(entry => entry.action === 'remove').map(entry => entry.path))

  return { entries: entries.filter(entry => entry.inside === undefined || !listed.has(entry.inside)), skipped: rejected }
}
