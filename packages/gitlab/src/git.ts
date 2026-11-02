import { runTool } from '@kaynooo/cli-kit'

export { cwdGone, defaultBranch, fetchBranch, git, gitOk, leaveWorktree, resolveCommit } from '@kaynooo/cli-kit'

// The subject of each commit the clone has, by sha; one it lacks is left out.
export async function subjects(shas: string[]): Promise<Map<string, string>> {
  if (shas.length === 0)
    return new Map()

  const out = (await runTool('git log', ['git', 'log', '--ignore-missing', '--no-walk', '--format=%H %s', ...shas])).stdout.trim()

  return new Map(out.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]))
}
