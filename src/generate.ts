import type { AuthorInfo, ChangelogOptions } from './types'
import { getGitDiff } from './changelog'
import { resolveConfig } from './config'
import { generateDiscordPayload } from './discord'
import { resolveAuthors } from './gitea'
import { generateMarkdown } from './markdown'
import { parseCommits } from './parse'

export async function generate(options: ChangelogOptions) {
  const resolved = await resolveConfig(options)

  const rawCommits = await getGitDiff(resolved.from, resolved.to, resolved.firstParent)
  const commits = parseCommits(rawCommits, resolved)
  const contributors: AuthorInfo[] = resolved.contributors ? await resolveAuthors(commits, resolved) : []

  const md = generateMarkdown(commits, resolved, contributors)
  const discord = generateDiscordPayload(commits, resolved, contributors)

  return { config: resolved, md, discord, commits, contributors }
}
