import { $ } from 'bun'

// Types and logic inlined from `changelogen` (MIT) to avoid pulling in its
// transitive dependency tree — only `getGitDiff` and `parseGitCommit` are used.

export type SemverBumpType = 'major' | 'premajor' | 'minor' | 'preminor' | 'patch' | 'prepatch' | 'prerelease'

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket'

export interface ChangelogConfig {
  cwd: string
  types: Record<string, { title: string, semver?: SemverBumpType, folded?: boolean } | boolean>
  scopeMap: Record<string, string>
  repo?: string
  tokens: Partial<Record<RepoProvider, string>>
  from: string
  to: string
  newVersion?: string
  signTags?: boolean
  output: string | boolean
  publish: {
    args?: string[]
    tag?: string
    private?: boolean
  }
  templates: {
    commitMessage?: string
    tagMessage?: string
    tagBody?: string
  }
  noAuthors: boolean
  excludeAuthors: string[]
  hideAuthorEmail?: boolean
}

export interface GitCommitAuthor {
  name: string
  email: string
}

export interface RawGitCommit {
  message: string
  body: string
  shortHash: string
  author: GitCommitAuthor
}

export interface Reference {
  type: 'hash' | 'issue' | 'pull-request'
  value: string
  title?: string
}

export interface GitCommit extends RawGitCommit {
  description: string
  type: string
  scope: string
  references: Reference[]
  authors: GitCommitAuthor[]
  isBreaking: boolean
  // The migration note of a BREAKING CHANGE footer, when it has one.
  breakingNote?: string
}

const ConventionalCommitRegex = /^(?::.+:|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF]|[\u2600-\u2B55])? *(?<type>[a-z]+)(?:\((?<scope>[^()\n]+)\))?(?<breaking>!)?: (?<description>.+)/i
const CoAuthoredByRegex = /co-authored-by:\s*(?<name>\S[^<]*)<(?<email>[^>]+)>/gi
const PullRequestRE = /\([ a-z]*(#\d+)\s*\)/g
const IssueRE = /(#\d+)/g
// The footer is uppercase by the Conventional Commits spec; its note runs on over the lines up to a blank one or the next trailer.
const BreakingBodyRE = /^BREAKING[ -]CHANGE:[ \t]*(.*(?:\n(?![ \t]*$|[\w-]+(?:: | #)).+)*)/m
const TicketLineRE = /^(#\d+) - (.+)$/gm

export async function getGitDiff(from: string | undefined, to = 'HEAD', firstParent = false): Promise<RawGitCommit[]> {
  const range = `${from !== undefined && from !== '' ? `${from}..` : ''}${to}`
  const pretty = '%x1e%s%x00%h%x00%an%x00%ae%x00%b'
  const flags = firstParent ? ['--first-parent'] : []
  const output = await $`git --no-pager log ${range} ${flags} --pretty=${pretty}`.quiet().text()

  return output
    .split('\x1E')
    .slice(1)
    .map((record) => {
      const [message = '', shortHash = '', authorName = '', authorEmail = '', body = ''] = record.split('\0')

      return {
        message,
        shortHash,
        author: { name: authorName, email: authorEmail },
        body: body.trim(),
      }
    })
}

export function parseGitCommit(commit: RawGitCommit, config: ChangelogConfig): GitCommit | null {
  const match = commit.message.match(ConventionalCommitRegex)

  if (!match?.groups)
    return null

  // Conventional Commits types are not case-sensitive, and the notes group them by their lower-case name.
  const type = (match.groups.type ?? '').toLowerCase()
  const breakingBody = BreakingBodyRE.exec(commit.body)
  const breakingNote = breakingBody?.[1]?.replaceAll(/\s+/g, ' ').trim()
  const rawScope = match.groups.scope ?? ''
  // Mapped here once, so the renderers print commit.scope as it is; an own key only, as `constructor` is no mapping.
  const scope = Object.hasOwn(config.scopeMap, rawScope) ? config.scopeMap[rawScope]! : rawScope
  const isBreaking = match.groups.breaking !== undefined || breakingBody !== null
  let description = match.groups.description ?? ''
  const references: Reference[] = []

  for (const m of description.matchAll(PullRequestRE))
    references.push({ type: 'pull-request', value: m[1]! })

  for (const m of description.matchAll(IssueRE)) {
    if (!references.some(i => i.value === m[1]))
      references.push({ type: 'issue', value: m[1]! })
  }

  for (const m of commit.body.matchAll(TicketLineRE)) {
    const known = references.find(i => i.value === m[1])

    if (known)
      known.title = m[2]!.trim()
    else
      references.push({ type: 'issue', value: m[1]!, title: m[2]!.trim() })
  }

  references.push({ value: commit.shortHash, type: 'hash' })
  description = description.replace(PullRequestRE, '').trim()

  const authors: GitCommitAuthor[] = [commit.author]

  for (const m of commit.body.matchAll(CoAuthoredByRegex)) {
    authors.push({
      name: (m.groups?.name ?? '').trim(),
      email: (m.groups?.email ?? '').trim(),
    })
  }

  return {
    ...commit,
    authors,
    description,
    type,
    scope,
    references,
    isBreaking,
    ...(breakingNote === undefined || breakingNote === '' ? {} : { breakingNote }),
  }
}
