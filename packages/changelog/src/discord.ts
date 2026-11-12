import type { DiscordWebhookPayload } from '@kaynooo/utils/types/discord'
import type { Highlights } from './highlights'
import type { AuthorInfo, Commit, ResolvedChangelogOptions } from './types'
import { compareUrl, foldedCounts, formatLine, formatTitle, groupCommits, releaseUrl, shortRef } from './markdown'

// Discord rejects an embed whose description runs past this many characters.
const descriptionLimit = 4096
const color = 0xFB923C
const breakingColor = 0xED4245

const fenceRE = /^\s*(`{3,}|~{3,})/
const headingRE = /^#{1,6}(?:\s(.*))?$/
const strongRE = /\*\*|__/g

const isCommitLine = (line: string) => line.startsWith('- ')

// Drops commit lines from the end until the description fits, saying how many went; nothing when even the head and the tail alone run over.
function fitCommits(head: string[], lines: string[], tail: string) {
  const total = lines.filter(isCommitLine).length

  for (let kept = lines.length; kept >= 0; kept--) {
    const shown = lines.slice(0, kept)

    while (shown.length && kept < lines.length && !isCommitLine(shown.at(-1)!))
      shown.pop()

    const more = total - shown.filter(isCommitLine).length
    const text = [...head, ...shown, ...(more ? ['', `*…and ${more} more*`] : []), '', tail].join('\n').trim()

    if (text.length <= descriptionLimit)
      return text
  }

  return undefined
}

// Keeps the description under Discord's limit: commit lines go first, then the highlights' lines from the end, their title and the link to the page kept, and a code block cut open closed again.
function fitDescription(head: string[], lines: string[], tail: string) {
  const fitted = fitCommits(head, lines, tail)

  if (fitted !== undefined || !head.length)
    return fitted ?? tail.slice(0, descriptionLimit)

  for (let kept = head.length - 2; kept >= 1; kept--) {
    const shown = head.slice(0, kept)

    const open = openFence(shown)

    if (open !== undefined)
      shown.push(open)

    const text = fitCommits([...shown, '…', head.at(-1)!], lines, tail)

    if (text !== undefined)
      return text
  }

  return tail.slice(0, descriptionLimit)
}

// The marker of a code block the lines leave open, which closes it again.
function openFence(lines: string[]) {
  let open: string | undefined

  for (const line of lines) {
    const marker = fenceRE.exec(line)?.[1]

    if (marker !== undefined)
      open = open !== undefined && marker.startsWith(open) ? undefined : open ?? marker
  }

  return open
}

const tableRowRE = /^\s*\|.*\|\s*$/
const tableRuleRE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/
// A `|` inside a code span or escaped is part of a cell.
const cellSplitRE = /(?<!\\)\|(?=(?:[^`]*`[^`]*`)*[^`]*$)/

// Discord draws no table: each row becomes a bullet, its first cell in bold and the others after it, the header and rule rows dropped.
function bulletedTables(lines: string[]) {
  let fenced = false
  const out: string[] = []

  for (const [index, line] of lines.entries()) {
    if (fenceRE.test(line))
      fenced = !fenced

    if (fenced || !tableRowRE.test(line)) {
      out.push(line)

      continue
    }

    // The header row is the one followed by the rule row.
    if (tableRuleRE.test(line) || tableRuleRE.test(lines[index + 1] ?? ''))
      continue

    const [first = '', ...rest] = line.trim().slice(1, -1).split(cellSplitRE).map(cell => cell.trim())

    out.push(`- **${first}**${rest.length ? `: ${rest.join(' · ')}` : ''}`)
  }

  return out
}

// The highlights as Discord shows them: under a bold title, their headings in bold too, as an embed draws no heading.
function highlightLines(highlights: Highlights, options: ResolvedChangelogOptions) {
  let fenced = false
  const lines = bulletedTables(highlights.lines).flatMap((line) => {
    if (fenceRE.test(line))
      fenced = !fenced

    const heading = fenced ? null : headingRE.exec(line)

    if (!heading)
      return [line]

    // Its own bold would close the one around it; an empty heading has nothing to show.
    const text = (heading[1] ?? '').replace(strongRE, '').trim()

    return text ? [`**${text}**`] : []
  })

  return [`**${formatTitle(options.titles.highlights!, options)}**`, ...lines, `[Read more](${highlights.link})`]
}

export function generateDiscordPayload(commits: Commit[], options: ResolvedChangelogOptions, contributors: AuthorInfo[] = [], highlights?: Highlights): DiscordWebhookPayload {
  const { sections, folded } = groupCommits(commits, options)
  const lines: string[] = []

  for (const section of sections) {
    lines.push('', `**${formatTitle(section.title, options)}**`)

    for (const commit of section.commits.toReversed())
      lines.push(`- ${formatLine(commit, options, commit.scope ? `**${commit.scope}**: ` : '', true)}`)
  }

  if (!sections.length && !folded.length)
    lines.push('*No significant changes*')

  const links = `[full notes](${releaseUrl(options)}) · [diff](${compareUrl(options)})`
  const tail = folded.length ? `${formatTitle(options.titles.maintenance!, options)} *${foldedCounts(folded, options)}* · ${links}` : links
  const authors = contributors.map(c => c.login ?? c.name).join(', ')
  const range = `${shortRef(options.from)} → ${shortRef(options.to)}`
  const avatar = contributors.find(c => c.avatar !== undefined)?.avatar

  return {
    embeds: [{
      title: `${String(options.releaseRepo).split('/').at(-1)} ${options.name || options.to}`.slice(0, 256),
      url: releaseUrl(options),
      color: commits.some(c => c.isBreaking) ? breakingColor : color,
      description: fitDescription(highlights ? highlightLines(highlights, options) : [], lines, tail),
      footer: { text: authors ? `${authors} · ${range}` : range, ...(avatar === undefined ? {} : { icon_url: avatar }) },
      timestamp: new Date().toISOString(),
    }],
  }
}
