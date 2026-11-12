import type { AuthorInfo, ChangelogOptions } from './types'
import { getGitDiff } from './changelog'
import { resolveConfig } from './config'
import { generateDiscordPayload } from './discord'
import { resolveAuthors } from './gitea'
import { readHighlights } from './highlights'
import { generateMarkdown } from './markdown'
import { parseCommits } from './parse'

export async function generate(options: ChangelogOptions) {
  const resolved = await resolveConfig(options)

  const rawCommits = await getGitDiff(resolved.fromRoot === true ? undefined : resolved.from, resolved.to, resolved.firstParent)
  const commits = parseCommits(rawCommits, resolved)
  const contributors: AuthorInfo[] = resolved.contributors ? await resolveAuthors(commits, resolved) : []

  const highlights = await readHighlights(resolved)

  const md = generateMarkdown(commits, resolved, contributors, highlights)
  const discord = generateDiscordPayload(commits, resolved, contributors, highlights)

  return { config: resolved, md, discord, commits, contributors }
}
