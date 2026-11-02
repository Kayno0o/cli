import { basename, dirname } from 'node:path'
import process from 'node:process'
import { fail } from './args'
import { cwdGone, runTool } from './tool'

const ORIGIN_PREFIX = /^origin\//

// How long a git call that reaches the network waits for origin.
export const GIT_NETWORK_MS = 60_000

// Runs git and returns its trimmed output; throws with git's own message on a failure, or when git cannot start or outlives `timeoutMs`.
export async function git(args: string[], timeoutMs?: number): Promise<string> {
  const result = await runTool(`git ${args.join(' ')}`, ['git', ...args], { timeoutMs })

  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim() || `exit ${result.code}`}${cwdGone() ? ' (the working directory was removed)' : ''}`)

  return result.stdout.trim()
}

export async function gitOk(args: string[]): Promise<boolean> {
  return (await runTool(`git ${args.join(' ')}`, ['git', ...args])).code === 0
}

export async function resolveCommit(ref: string): Promise<string> {
  const sha = (await runTool('git rev-parse', ['git', 'rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])).stdout.trim()

  if (sha === '')
    fail(`no commit ${ref}`)

  return sha
}

// Fetches one branch of origin; a name that is no branch, such as `--upload-pack=<command>`, is refused before git reads it, and the refspec is spelled out so it can never be an option.
export async function fetchBranch(branch: string): Promise<void> {
  if (branch.startsWith('-') || !await gitOk(['check-ref-format', '--branch', branch]))
    fail(`${branch} is not a branch name`)

  await git(['fetch', '-q', 'origin', `refs/heads/${branch}`], GIT_NETWORK_MS)
}

// The branch origin's HEAD names, which is the repository's default branch once cloned or `git remote set-head origin -a` ran.
export async function defaultBranch(): Promise<string> {
  const head = (await runTool('git symbolic-ref', ['git', 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).stdout.trim()

  return head === '' ? 'main' : head.replace(ORIGIN_PREFIX, '')
}

// A linked worktree can be deleted while a wait runs in it, so the wait moves to the main checkout, which outlives it.
export async function leaveWorktree(): Promise<void> {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])

  if (basename(common) === '.git')
    process.chdir(dirname(common))
}
