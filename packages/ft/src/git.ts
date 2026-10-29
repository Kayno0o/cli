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
  const sha = (await $`git rev-parse --verify -q ${`${ref}^{commit}`}`.quiet().nothrow().text()).trim()

  if (sha === '')
    fail(`no commit ${ref}`)

  return sha
}

// The branch origin's HEAD names, which is the repository's default branch once cloned or `git remote set-head origin -a` ran.
export async function defaultBranch(): Promise<string> {
  const head = (await $`git symbolic-ref --short -q refs/remotes/origin/HEAD`.quiet().nothrow().text()).trim()

  return head === '' ? 'main' : head.replace(ORIGIN_PREFIX, '')
}

export async function tagsAt(commit: string): Promise<string[]> {
  return (await git(['tag', '--points-at', commit])).split('\n').filter(Boolean)
}
