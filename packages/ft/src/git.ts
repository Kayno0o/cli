import { basename, dirname } from 'node:path'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { $ } from 'bun'

const ORIGIN_PREFIX = /^origin\//

// A spawn failing before the command runs says only "No such file or directory", which names the working directory once it was deleted.
export function spawnFailure(command: string, error: unknown): Error {
  return new Error(`${command}: ${error instanceof Error ? error.message : String(error)}${cwdGone() ? ' (the working directory was removed)' : ''}`)
}

export async function git(args: string[]): Promise<string> {
  let result

  try {
    result = await $`git ${args}`.quiet().nothrow()
  }
  catch (error) {
    throw spawnFailure(`git ${args.join(' ')}`, error)
  }

  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)

  return result.stdout.toString().trim()
}

export async function gitOk(args: string[]): Promise<boolean> {
  return (await $`git ${args}`.quiet().nothrow()).exitCode === 0
}

export async function resolveCommit(ref: string): Promise<string> {
  const sha = (await $`git rev-parse --verify -q --end-of-options ${`${ref}^{commit}`}`.quiet().nothrow().text()).trim()

  if (sha === '')
    fail(`no commit ${ref}`)

  return sha
}

// Fetches one branch of origin; a name that is no branch, such as `--upload-pack=<command>`, is refused before git reads it, and the refspec is spelled out so it can never be an option.
export async function fetchBranch(branch: string): Promise<void> {
  if (branch.startsWith('-') || !await gitOk(['check-ref-format', '--branch', branch]))
    fail(`${branch} is not a branch name`)

  await git(['fetch', '-q', 'origin', `refs/heads/${branch}`])
}

// The branch origin's HEAD names, which is the repository's default branch once cloned or `git remote set-head origin -a` ran.
export async function defaultBranch(): Promise<string> {
  const head = (await $`git symbolic-ref --short -q refs/remotes/origin/HEAD`.quiet().nothrow().text()).trim()

  return head === '' ? 'main' : head.replace(ORIGIN_PREFIX, '')
}

export async function tagsAt(commit: string): Promise<string[]> {
  return (await git(['tag', '--points-at', commit])).split('\n').filter(Boolean)
}

export interface Named { sha: string, subject: string }

// The commits of a ref whose message names the issue, oldest first.
export async function commitsNaming(issue: number, ref: string): Promise<Named[]> {
  const out = await git(['log', ref, '--reverse', '--extended-regexp', `--grep=#${issue}([^0-9]|$)`, '--format=%H %s'])

  return out.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ')

    return { sha: line.slice(0, space), subject: line.slice(space + 1) }
  })
}

// True once the directory the process runs in was deleted, as a worktree is after its work lands.
export function cwdGone(): boolean {
  try {
    process.cwd()

    return false
  }
  catch {
    return true
  }
}

// A linked worktree can be deleted while a wait runs in it, so the wait moves to the main checkout, which outlives it.
export async function leaveWorktree(): Promise<void> {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])

  if (basename(common) === '.git')
    process.chdir(dirname(common))
}
