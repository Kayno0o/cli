import type { Comment } from './claims'
import { pool } from '@kaynooo/cli-kit'
import { concurrencyOf } from './config'
import { api, repoApi, repoWrite, tea } from './tea'

export interface Issue { number: number, title: string, body: string, state: string, html_url: string, comments: number, labels: { name: string }[], milestone?: { id: number, title: string } | null }
export interface IssueComment extends Comment { user: { login: string } }

const PAGE = 50
// Comment fetches in flight at once, enough to read a backlog's comments in about a second.
const CONCURRENCY = 8

export async function getIssue(number: number, repo?: string): Promise<Issue> {
  return repoApi<Issue>(`issues/${number}`, repo)
}

async function listIssues(state: 'open' | 'closed', filter: string, repo?: string): Promise<Issue[]> {
  const issues: Issue[] = []

  for (let page = 1; ; page++) {
    const batch = await repoApi<Issue[]>(`issues?state=${state}&type=issues&page=${page}&limit=${PAGE}${filter}`, repo)

    issues.push(...batch)

    if (batch.length < PAGE)
      return issues
  }
}

// The open issues, narrowed to some labels and/or a milestone given by id.
export async function openIssues(labels: string | undefined, repo?: string, milestone?: number): Promise<Issue[]> {
  return listIssues('open', `${labels === undefined ? '' : `&labels=${encodeURIComponent(labels)}`}${milestone === undefined ? '' : `&milestones=${milestone}`}`, repo)
}

export async function closedIssues(milestone: number, repo?: string): Promise<Issue[]> {
  return listIssues('closed', `&milestones=${milestone}`, repo)
}

export async function commentsOf(number: number, repo?: string): Promise<IssueComment[]> {
  return repoApi<IssueComment[]>(`issues/${number}/comments`, repo)
}

// Each issue's comments, an issue without any skipping the call.
export async function commentsOfAll(issues: Issue[], repo?: string): Promise<Map<number, IssueComment[]>> {
  const commented = issues.filter(issue => issue.comments > 0)
  const comments = await pool(commented, concurrencyOf(CONCURRENCY), async issue => commentsOf(issue.number, repo))

  return new Map(commented.map((issue, index) => [issue.number, comments[index]!]))
}

// `tea api` cannot write issues with an OAuth login, so writes go through tea's own commands, with `-d` as tea 0.15 has no description file; an empty milestone clears it.
export async function editIssue(number: number, change: { title?: string, body?: string, milestone?: string }, repo?: string): Promise<void> {
  const args = [String(number)]

  if (change.title !== undefined)
    args.push('-t', change.title)

  if (change.body !== undefined)
    args.push('-d', change.body)

  if (change.milestone !== undefined)
    args.push('-m', change.milestone)

  await tea(['issues', 'edit'], args, repo)
}

export async function setBody(number: number, body: string, repo?: string): Promise<void> {
  await editIssue(number, { body }, repo)
}

// tea prints the new issue in a boxed view no script can read, so it is found again among the open issues with that title and body that were not there before; two sessions creating the same issue at once fail rather than swap.
export async function createIssue(title: string, body: string, labels: string | undefined, milestone: string | undefined, repo?: string): Promise<Issue> {
  const args = ['-t', title, '-d', body]
  const same = (found: Issue) => found.title === title && sameText(found.body, body)
  const known = new Set((await openIssues(undefined, repo)).filter(same).map(found => found.number))

  if (labels !== undefined)
    args.push('-L', labels)

  if (milestone !== undefined)
    args.push('-m', milestone)

  await tea(['issues', 'create'], args, repo)

  const created = (await openIssues(undefined, repo)).filter(found => same(found) && !known.has(found.number))

  if (created.length > 1)
    throw new Error(`created "${title}" but ${created.map(found => `#${found.number}`).join(' and ')} both match: another session created the same issue at once`)

  if (created[0] === undefined)
    throw new Error(`created "${title}" but cannot find it among the open issues`)

  return created[0]
}

// Forgejo stores a body with Unix line ends and may trim its end.
function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n').trimEnd() === b.replaceAll('\r\n', '\n').trimEnd()
}

const EDIT_TRIES = 3

// Re-reads the body right before writing it and once after, so an edit made in between is not overwritten silently: a body that is not what was written is changed again from the fresh one, and the third failure throws. `change` must give the same result when run twice.
export async function editBody(number: number, change: (body: string) => string, repo?: string): Promise<boolean> {
  let wrote = false

  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const { body } = await getIssue(number, repo)
    const next = change(body)

    if (next === body)
      return wrote

    await setBody(number, next, repo)
    wrote = true

    if (sameText((await getIssue(number, repo)).body, next))
      return true
  }

  throw new Error(`#${number}: its description keeps changing under the edit, so it was not written reliably`)
}

// The login the comments of this session's tea login carry, which is the only author a claim comment counts from; undefined when it cannot be read.
let login: string | undefined

export async function sessionAuthor(): Promise<string | undefined> {
  if (login !== undefined)
    return login

  try {
    login = (await api<{ login?: string }>('user')).login
  }
  catch {
    return undefined
  }

  return login
}

// Posted through `tea api`, where the body is a field value and never a command-line option, whatever it starts with.
export async function comment(number: number, body: string, repo?: string): Promise<void> {
  await repoWrite('POST', `issues/${number}/comments`, { body }, repo)
}

export async function close(number: number, repo?: string): Promise<void> {
  await tea(['issues', 'close'], [String(number)], repo)
}

export async function reopen(number: number, repo?: string): Promise<void> {
  await tea(['issues', 'reopen'], [String(number)], repo)
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
  const args = [String(number)]

  if (add.length > 0)
    args.push('--add-labels', add.join(','))

  if (remove.length > 0)
    args.push('--remove-labels', remove.join(','))

  await tea(['issues', 'edit'], args, repo)
}
