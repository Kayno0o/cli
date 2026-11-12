import type { Repo } from './repos'
import { git } from './git'
import { repoState } from './repos'

export type SyncOutcome = 'updated' | 'current' | 'fetched' | 'skipped' | 'refused'

export interface SyncResult {
  path: string
  branch: string | null
  upstream: string | null
  // The commits the fast-forward brought in, or with `pull` off the ones waiting upstream.
  commits: number | null
  outcome: SyncOutcome
  reason?: string
}

const GIT_FAILURE = /^(?:error: |fatal: )/
const LISTED = /^\s/
const LOCAL_CHANGES = /local changes .* would be overwritten/
const UNTRACKED = /untracked working tree files would be overwritten/

// The line of git's output saying why it failed, with the indented paths git lists below it; the two ways a fast-forward is refused over the working tree are said with the paths and what to do.
function whyFailed(stderr: string, fallback: string): string {
  const lines = stderr.split('\n').map(line => line.trimEnd()).filter(Boolean)
  const at = lines.findIndex(line => GIT_FAILURE.test(line))

  if (at === -1)
    return (lines.at(-1) ?? fallback).trim()

  const line = lines[at]!.trim()
  const listed: string[] = []

  for (const next of lines.slice(at + 1)) {
    if (!LISTED.test(next))
      break

    listed.push(next.trim())
  }

  if (listed.length === 0)
    return line

  const paths = listed.join(', ')

  if (LOCAL_CHANGES.test(line))
    return `uncommitted changes in files the fast-forward changes (${paths}): commit them first (gc), or set them aside as a patch (gu)`

  if (UNTRACKED.test(line))
    return `untracked files the fast-forward would overwrite (${paths}): move them aside first`

  return `${line} ${paths}`
}

/** Fetches with prune, then fast-forwards the branch onto its upstream: a branch that has diverged, or a tree a fast-forward would overwrite, is refused and left as it was. */
export async function sync(repo: Repo, { pull }: { pull: boolean }): Promise<SyncResult> {
  const { path, dir } = repo
  const refused = (reason: string, branch: string | null = null, upstream: string | null = null): SyncResult => ({ path, branch, upstream, commits: null, outcome: 'refused', reason })

  const fetched = await git(['-C', dir, 'fetch', '--prune'])

  if (fetched.code !== 0)
    return refused(whyFailed(fetched.stderr, 'git fetch failed'), repo.status?.branch ?? null)

  const { status } = await repoState(dir)

  if (status === null)
    return refused('git could not read it')

  const { branch, upstream, aheadBehind } = status
  const skipped = (reason: string): SyncResult => ({ path, branch, upstream, commits: null, outcome: 'skipped', reason })

  if (branch === '(detached)')
    return skipped('detached HEAD, fetched only')

  if (upstream === null)
    return skipped('no upstream, fetched only')

  if (aheadBehind === null)
    return skipped('upstream gone, fetched only')

  const { ahead, behind } = aheadBehind

  if (behind === 0)
    return { path, branch, upstream, commits: 0, outcome: 'current' }

  if (ahead > 0)
    return refused(`diverged: ${ahead} ahead, ${behind} behind, nothing merged`, branch, upstream)

  if (!pull)
    return { path, branch, upstream, commits: behind, outcome: 'fetched' }

  const merged = await git(['-C', dir, 'merge', '--ff-only', '--quiet', upstream])

  return merged.code === 0 ? { path, branch, upstream, commits: behind, outcome: 'updated' } : refused(whyFailed(merged.stderr, 'git merge failed'), branch, upstream)
}
