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
export async function setBody(number: number, body: string, repo?: string): Promise<void> {
  await tea(['issues', 'edit', String(number), '-d', body], repo)
}

export async function comment(number: number, body: string, repo?: string): Promise<void> {
  await tea(['comment', String(number), body], repo)
}

export async function close(number: number, repo?: string): Promise<void> {
  await tea(['issues', 'close', String(number)], repo)
}
