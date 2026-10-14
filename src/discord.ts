import type { DiscordWebhookPayload } from '@kaynooo/utils'
import type { AuthorInfo, Commit, ResolvedChangelogOptions } from './types'
import { compareUrl, foldedCounts, formatLine, formatTitle, groupCommits, releaseUrl, shortRef } from './markdown'

// Discord rejects an embed whose description runs past this many characters.
const descriptionLimit = 4096
const color = 0xFB923C
const breakingColor = 0xED4245

const isCommitLine = (line: string) => line.startsWith('- ')

// Keeps the description under Discord's limit by dropping commit lines from the end, saying how many went.
function fitDescription(lines: string[], tail: string) {
  const total = lines.filter(isCommitLine).length

  for (let kept = lines.length; kept >= 0; kept--) {
    const shown = lines.slice(0, kept)

    while (shown.length && kept < lines.length && !isCommitLine(shown.at(-1)!))
      shown.pop()

    const more = total - shown.filter(isCommitLine).length
    const text = [...shown, ...(more ? ['', `*…and ${more} more*`] : []), '', tail].join('\n').trim()

    if (text.length <= descriptionLimit)
      return text
  }

  return tail.slice(0, descriptionLimit)
}

export function generateDiscordPayload(commits: Commit[], options: ResolvedChangelogOptions, contributors: AuthorInfo[] = []): DiscordWebhookPayload {
  const { sections, folded } = groupCommits(commits, options)
  const lines: string[] = []

  for (const section of sections) {
    lines.push('', `**${formatTitle(section.title, options)}**`)

    for (const commit of section.commits.toReversed())
      lines.push(`- ${formatLine(commit, options, commit.scope ? `**${options.scopeMap[commit.scope] || commit.scope}**: ` : '', true)}`)
  }

  if (!sections.length && !folded.length)
    lines.push('*No significant changes*')

  const links = `[full notes](${releaseUrl(options)}) · [diff](${compareUrl(options)})`
  const tail = folded.length ? `${formatTitle(options.titles.maintenance!, options)} *${foldedCounts(folded, options)}* · ${links}` : links
  const authors = contributors.map(c => c.login || c.name).join(', ')
  const range = `${shortRef(options.from)} → ${shortRef(options.to)}`

  return {
    embeds: [{
      title: `${String(options.releaseRepo).split('/').at(-1)} ${options.name || options.to}`.slice(0, 256),
      url: releaseUrl(options),
      color: commits.some(c => c.isBreaking) ? breakingColor : color,
      description: fitDescription(lines, tail),
      footer: { text: authors ? `${authors} · ${range}` : range, icon_url: contributors.find(c => c.avatar)?.avatar },
      timestamp: new Date().toISOString(),
    }],
  }
}
