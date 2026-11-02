import type { Reference } from './changelog'
import type { Highlights } from './highlights'
import type { AuthorInfo, Commit, ResolvedChangelogOptions } from './types'
import { capitalize, groupBy } from '@kaynooo/utils'

const emojiRE = /\p{Extended_Pictographic}\uFE0F?/gu
const fullHashRE = /^[\da-f]{40}$/

export interface Section {
  title: string
  commits: Commit[]
}

export interface GroupedCommits {
  sections: Section[]
  folded: Section[]
}

// Breaking commits lead whatever their type, and the types marked `folded` are kept apart for the maintenance block.
export function groupCommits(commits: Commit[], options: ResolvedChangelogOptions): GroupedCommits {
  const breaking = commits.filter(c => c.isBreaking)
  const byType = groupBy(commits.filter(c => !c.isBreaking), c => c.type)
  const sections: Section[] = breaking.length ? [{ title: options.titles.breakingChanges!, commits: breaking }] : []
  const folded: Section[] = []

  for (const [type, config] of Object.entries(options.types)) {
    const typed = byType[type] ?? []

    if (typeof config === 'boolean' || typed.length === 0)
      continue

    const target = config.folded === true ? folded : sections

    target.push({ title: config.title, commits: typed })
  }

  return { sections, folded }
}

export function formatTitle(title: string, options: ResolvedChangelogOptions) {
  return (options.emoji ? title : title.replace(emojiRE, '')).trim()
}

// A range starting at the first commit names it by its full hash, too long to read.
export function shortRef(ref: string) {
  return fullHashRE.test(ref) ? ref.slice(0, 7) : ref
}

export function repoUrl(options: ResolvedChangelogOptions) {
  return `https://${options.baseUrl}/${options.repo}`
}

export function compareUrl(options: ResolvedChangelogOptions) {
  return `${repoUrl(options)}/compare/${options.from}...${options.to}`
}

export function releaseUrl(options: ResolvedChangelogOptions) {
  return `https://${options.baseUrl}/${options.releaseRepo}/releases/tag/${encodeURIComponent(options.to)}`
}

export function userUrl(login: string, options: ResolvedChangelogOptions) {
  return `https://${options.baseUrl}/${login}`
}

function formatIssue(ref: Reference, options: ResolvedChangelogOptions, withTitle: boolean) {
  const text = withTitle && ref.title !== undefined ? `${ref.value} ${ref.title}` : ref.value

  return `[${text}](${repoUrl(options)}/issues/${ref.value.slice(1)})`
}

// One commit as `description · hash · issues`; Discord has no hover card on issue links, so it asks for their titles inline.
export function formatLine(commit: Commit, options: ResolvedChangelogOptions, prefix = '', issueTitles = false) {
  const description = options.capitalize ? capitalize(commit.description) : commit.description
  const hash = `[\`${commit.shortHash.slice(0, 7)}\`](${repoUrl(options)}/commit/${commit.shortHash})`
  const issues = commit.references
    .filter(ref => ref.type !== 'hash')
    .map(ref => formatIssue(ref, options, issueTitles))

  return [`${prefix}${description}`, hash, ...issues].join(' · ')
}

export function foldedPrefix(commit: Commit) {
  return `**${commit.scope ? `${commit.type}(${commit.scope})` : commit.type}**: `
}

export function foldedCounts(folded: Section[], options: ResolvedChangelogOptions) {
  return folded.map(section => `${section.commits.length} ${formatTitle(section.title, options)}`).join(', ')
}

export function formatAuthors(contributors: AuthorInfo[], options: ResolvedChangelogOptions) {
  return join(contributors.map(c => c.login !== undefined ? `[@${c.login}](${userUrl(c.login, options)})` : `**${c.name}**`))
}

function summaryLabel(title: string) {
  return title.replace(emojiRE, '').trim().toLowerCase()
}

function formatSummary({ sections, folded }: GroupedCommits, contributors: AuthorInfo[], options: ResolvedChangelogOptions) {
  const counts = sections.map(section => `${section.commits.length} ${summaryLabel(section.title)}`)

  if (folded.length) {
    const total = folded.reduce((sum, section) => sum + section.commits.length, 0)

    counts.push(`${total} ${summaryLabel(options.titles.maintenance!)}`)
  }

  const authors = formatAuthors(contributors, options)
  const parts = [
    counts.length ? `**${counts.join(' · ')}**` : '',
    authors && `by ${authors}`,
    `\`${shortRef(options.from)}\` → \`${shortRef(options.to)}\``,
  ]

  return `> ${parts.filter(Boolean).join(' · ')}`
}

function formatSection(section: Section, options: ResolvedChangelogOptions) {
  const lines = ['', `### ${formatTitle(section.title, options)}`, '']
  const scopes = groupBy(section.commits, c => c.scope)

  // Nesting under scopes only pays off when one of them holds several commits.
  const nestable = Object.entries(scopes).some(([scope, commits]) => scope !== '' && commits.length > 1)

  for (const [scope, commits] of Object.entries(scopes).sort(([a], [b]) => a.localeCompare(b))) {
    const scopeText = `**${options.scopeMap[scope] ?? scope}**`
    const nested = nestable && scope !== '' && (options.group === true || (options.group === 'multiple' && commits.length > 1))
    const prefix = scope !== '' && !nested ? `${scopeText}: ` : ''
    const padding = nested ? '  ' : ''

    if (nested)
      lines.push(`- ${scopeText}:`)

    for (const commit of commits.toReversed())
      lines.push(`${padding}- ${formatLine(commit, options, prefix)}`)
  }

  return lines
}

function formatAvatars(contributors: AuthorInfo[], options: ResolvedChangelogOptions) {
  return contributors
    .filter(c => c.login !== undefined && c.avatar !== undefined)
    .map(c => `<a href="${userUrl(c.login!, options)}"><img src="${c.avatar}" width="28" height="28" alt="@${c.login}"></a>`)
    .join(' ')
}

export function generateMarkdown(commits: Commit[], options: ResolvedChangelogOptions, contributors: AuthorInfo[] = [], highlights?: Highlights) {
  const grouped = groupCommits(commits, options)
  const { sections, folded } = grouped
  const lines = [formatSummary(grouped, contributors, options)]

  if (highlights)
    lines.push('', `### ${formatTitle(options.titles.highlights!, options)}`, '', ...highlights.lines, '', `[Read more](${highlights.link})`)

  for (const section of sections)
    lines.push(...formatSection(section, options))

  if (folded.length) {
    lines.push(
      '',
      '<details>',
      `<summary><b>${formatTitle(options.titles.maintenance!, options)}</b> · ${foldedCounts(folded, options)}</summary>`,
      '',
      ...folded.flatMap(section => section.commits.toReversed().map(commit => `- ${formatLine(commit, options, foldedPrefix(commit))}`)),
      '',
      '</details>',
    )
  }

  if (!sections.length && !folded.length)
    lines.push('', '*No significant changes*')

  lines.push('', '---', '')

  const avatars = formatAvatars(contributors, options)

  if (avatars)
    lines.push(avatars, '')

  lines.push(`<sub>[Full diff \`${shortRef(options.from)}...${shortRef(options.to)}\`](${compareUrl(options)}) · generated by cli-changelog</sub>`)

  return lines.join('\n')
}

function join(array: string[], glue = ', ', finalGlue = ' and '): string {
  return array.length <= 2 ? array.join(finalGlue) : `${array.slice(0, -1).join(glue)}${finalGlue}${array.at(-1)}`
}
