import { basename, dirname } from 'node:path'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { $ } from 'bun'

const ORIGIN_PREFIX = /^origin\//

export async function git(args: string[]): Promise<string> {
  const result = await $`git ${args}`.quiet().nothrow()

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

// The subject of each commit the clone has, by sha; one it lacks is left out.
export async function subjects(shas: string[]): Promise<Map<string, string>> {
  if (shas.length === 0)
    return new Map()

  const out = (await $`git log --ignore-missing --no-walk --format=${'%H %s'} ${shas}`.quiet().nothrow().text()).trim()

  return new Map(out.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]))
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
