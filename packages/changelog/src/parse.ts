import type { GitCommit, RawGitCommit } from './changelog'
import type { ChangelogenOptions } from './types'
import { notNullish } from '@kaynooo/utils/array'
import { parseGitCommit } from './changelog'

export function parseCommits(commits: RawGitCommit[], config: ChangelogenOptions): GitCommit[] {
  return commits.map(commit => parseGitCommit(commit, config)).filter(notNullish)
}
