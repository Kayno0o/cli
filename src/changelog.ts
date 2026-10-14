import { $ } from 'bun'

// Types and logic inlined from `changelogen` (MIT) to avoid pulling in its
// transitive dependency tree — only `getGitDiff` and `parseGitCommit` are used.

export type SemverBumpType = 'major' | 'premajor' | 'minor' | 'preminor' | 'patch' | 'prepatch' | 'prerelease'

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket'

export interface RepoConfig {
  domain?: string
  repo?: string
  provider?: RepoProvider
  token?: string
}

export interface ChangelogConfig {
  cwd: string
  types: Record<string, { title: string, semver?: SemverBumpType, folded?: boolean } | boolean>
  scopeMap: Record<string, string>
  repo?: RepoConfig | string
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
}

const ConventionalCommitRegex = /(?<emoji>:.+:|(\uD83C[\uDF00-\uDFFF])|(\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF])|[\u2600-\u2B55])?( *)(?<type>[a-z]+)(\((?<scope>.+)\))?(?<breaking>!)?: (?<description>.+)/i
const CoAuthoredByRegex = /co-authored-by:\s*(?<name>\S[^<]*)(<(?<email>[^>]+)>)/gi
const PullRequestRE = /\([ a-z]*(#\d+)\s*\)/g
const IssueRE = /(#\d+)/g
const TicketLineRE = /^(#\d+) - (.+)$/gm

export async function getGitDiff(from: string | undefined, to = 'HEAD', firstParent = false): Promise<RawGitCommit[]> {
  const range = `${from ? `${from}...` : ''}${to}`
  const pretty = '----%n%s|%h|%an|%ae%n%b'
  const flags = firstParent ? ['--first-parent'] : []
  const output = (await $`git --no-pager log ${range} ${flags} --pretty=${pretty} --name-status`.quiet().text()).trim()

  return output
    .split('----\n')
    .splice(1)
    .map((line) => {
      const [firstLine, ...body] = line.split('\n')
      const [message, shortHash, authorName, authorEmail] = firstLine.split('|')

      return {
        message,
        shortHash,
        author: { name: authorName, email: authorEmail },
        body: body.join('\n'),
      }
    })
}

export function parseGitCommit(commit: RawGitCommit, config: ChangelogConfig): GitCommit | null {
  const match = commit.message.match(ConventionalCommitRegex)

  if (!match?.groups)
    return null

  const type = match.groups.type
  const hasBreakingBody = (/breaking change:/i).test(commit.body)
  let scope = match.groups.scope || ''

  scope = config.scopeMap[scope] || scope
  const isBreaking = Boolean(match.groups.breaking || hasBreakingBody)
  let description = match.groups.description
  const references: Reference[] = []

  for (const m of description.matchAll(PullRequestRE))
    references.push({ type: 'pull-request', value: m[1] })

  for (const m of description.matchAll(IssueRE)) {
    if (!references.some(i => i.value === m[1]))
      references.push({ type: 'issue', value: m[1] })
  }

  for (const m of commit.body.matchAll(TicketLineRE)) {
    const known = references.find(i => i.value === m[1])

    if (known)
      known.title = m[2].trim()
    else
      references.push({ type: 'issue', value: m[1], title: m[2].trim() })
  }

  references.push({ value: commit.shortHash, type: 'hash' })
  description = description.replace(PullRequestRE, '').trim()

  const authors: GitCommitAuthor[] = [commit.author]

  for (const m of commit.body.matchAll(CoAuthoredByRegex)) {
    authors.push({
      name: (m.groups?.name || '').trim(),
      email: (m.groups?.email || '').trim(),
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
  }
}
