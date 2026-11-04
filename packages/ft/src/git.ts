import { git } from '@kaynooo/cli-kit'

export { cwdGone, defaultBranch, fetchBranch, git, gitOk, leaveWorktree, resolveCommit } from '@kaynooo/cli-kit'

export async function tagsAt(commit: string): Promise<string[]> {
  return (await git(['tag', '--points-at', commit])).split('\n').filter(Boolean)
}

export interface Named { sha: string, subject: string }

// The commits of a ref whose message names the issue, oldest first.
export async function commitsNaming(issue: number, ref: string): Promise<Named[]> {
  const out = await git(['log', ref, '--reverse', '--extended-regexp', `--grep=(^|[^[:alnum:]_./-])#${issue}([^0-9]|$)`, '--format=%H %s'])

  return out.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ')

    return { sha: line.slice(0, space), subject: line.slice(space + 1) }
  })
}
