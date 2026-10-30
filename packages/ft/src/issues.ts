import type { Comment } from './claims'
import { repoApi, tea } from './tea'

export interface Issue { number: number, title: string, body: string, state: string, html_url: string, comments: number, labels: { name: string }[] }
export interface IssueComment extends Comment { user: { login: string } }

const PAGE = 50
// Comment fetches in flight at once, enough to read a backlog's comments in about a second.
const CONCURRENCY = 8

export async function getIssue(number: number, repo?: string): Promise<Issue> {
  return repoApi<Issue>(`issues/${number}`, repo)
}

export async function openIssues(labels: string | undefined, repo?: string): Promise<Issue[]> {
  const issues: Issue[] = []
  const filter = labels === undefined ? '' : `&labels=${encodeURIComponent(labels)}`

  for (let page = 1; ; page++) {
    const batch = await repoApi<Issue[]>(`issues?state=open&type=issues&page=${page}&limit=${PAGE}${filter}`, repo)

    issues.push(...batch)

    if (batch.length < PAGE)
      return issues
  }
}

export async function commentsOf(number: number, repo?: string): Promise<IssueComment[]> {
  return repoApi<IssueComment[]>(`issues/${number}/comments`, repo)
}

// Each issue's comments, an issue without any skipping the call.
export async function commentsOfAll(issues: Issue[], repo?: string): Promise<Map<number, IssueComment[]>> {
  const result = new Map<number, IssueComment[]>()
  const queue = issues.filter(issue => issue.comments > 0)

  async function worker(): Promise<void> {
    for (let issue = queue.shift(); issue !== undefined; issue = queue.shift())
      result.set(issue.number, await commentsOf(issue.number, repo))
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  return result
}

// `tea api` cannot write with an OAuth login, so writes go through tea's own commands, with `-d` as tea 0.15 has no description file.
export async function editIssue(number: number, change: { title?: string, body?: string }, repo?: string): Promise<void> {
  const args = ['issues', 'edit', String(number)]

  if (change.title !== undefined)
    args.push('-t', change.title)

  if (change.body !== undefined)
    args.push('-d', change.body)

  await tea(args, repo)
}

export async function setBody(number: number, body: string, repo?: string): Promise<void> {
  await editIssue(number, { body }, repo)
}

// tea prints the new issue in a boxed view no script can read, so it is found again by its title, the newest one winning.
export async function createIssue(title: string, body: string, labels: string | undefined, repo?: string): Promise<Issue> {
  const args = ['issues', 'create', '-t', title, '-d', body]

  if (labels !== undefined)
    args.push('-L', labels)

  await tea(args, repo)

  const created = (await openIssues(undefined, repo)).filter(found => found.title === title).sort((a, b) => b.number - a.number)[0]

  if (created === undefined)
    throw new Error(`created "${title}" but cannot find it among the open issues`)

  return created
}

// Re-reads the body right before writing it, so an edit made since the caller last looked is not overwritten.
export async function editBody(number: number, change: (body: string) => string, repo?: string): Promise<boolean> {
  const { body } = await getIssue(number, repo)
  const next = change(body)

  if (next === body)
    return false

  await setBody(number, next, repo)

  return true
}

export async function comment(number: number, body: string, repo?: string): Promise<void> {
  await tea(['comment', String(number), body], repo)
}

export async function close(number: number, repo?: string): Promise<void> {
  await tea(['issues', 'close', String(number)], repo)
}

export async function reopen(number: number, repo?: string): Promise<void> {
  await tea(['issues', 'reopen', String(number)], repo)
}

export async function repoLabels(repo?: string): Promise<string[]> {
  const names: string[] = []

  for (let page = 1; ; page++) {
    const batch = await repoApi<{ name: string }[]>(`labels?page=${page}&limit=${PAGE}`, repo)

    names.push(...batch.map(each => each.name))

    if (batch.length < PAGE)
      return names
  }
}

export async function editLabels(number: number, add: string[], remove: string[], repo?: string): Promise<void> {
  const args = ['issues', 'edit', String(number)]

  if (add.length > 0)
    args.push('--add-labels', add.join(','))

  if (remove.length > 0)
    args.push('--remove-labels', remove.join(','))

  await tea(args, repo)
}
