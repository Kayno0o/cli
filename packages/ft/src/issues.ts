import type { Comment } from './claims'
import { pool } from '@kaynooo/cli-kit'
import { concurrencyOf } from './config'
import { findMilestone } from './milestones'
import { api, repoApi, repoSend, repoWrite, resolveForge } from './tea'

export interface Issue { number: number, title: string, body: string, state: string, html_url: string, comments: number, labels: { name: string }[], milestone?: { id: number, title: string } | null }
export interface IssueComment extends Comment { user: { login: string } }

interface GitLabIssueRaw {
  iid: number
  title: string
  description?: string | null
  state: string
  web_url: string
  user_notes_count?: number
  labels?: string[]
  milestone?: { id: number, title: string } | null
}

interface GitLabNoteRaw {
  body: string
  created_at: string
  system?: boolean
  author?: { username: string }
}

interface GitHubIssueRaw extends Issue {
  pull_request?: unknown
}

const PAGE = 50
// Comment fetches in flight at once, enough to read a backlog's comments in about a second.
const CONCURRENCY = 8

function fromGitLabIssue(raw: GitLabIssueRaw): Issue {
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state: raw.state === 'opened' ? 'open' : 'closed',
    html_url: raw.web_url,
    comments: raw.user_notes_count ?? 0,
    labels: (raw.labels ?? []).map(name => ({ name })),
    milestone: raw.milestone ?? null,
  }
}

export async function getIssue(number: number, repo?: string): Promise<Issue> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return fromGitLabIssue(await repoApi<GitLabIssueRaw>(`issues/${number}`, repo))

  return repoApi<Issue>(`issues/${number}`, repo)
}

async function listIssues(state: 'open' | 'closed', labels: string | undefined, repo?: string, milestone?: number): Promise<Issue[]> {
  const { provider } = await resolveForge(repo)
  const issues: Issue[] = []

  if (provider === 'gitlab') {
    const glState = state === 'open' ? 'opened' : 'closed'
    const labelPart = labels === undefined ? '' : `&labels=${encodeURIComponent(labels)}`
    const milestonePart = milestone === undefined ? '' : `&milestone_id=${milestone}`

    for (let page = 1; ; page++) {
      const batch = await repoApi<GitLabIssueRaw[]>(`issues?state=${glState}&per_page=${PAGE}&page=${page}${labelPart}${milestonePart}`, repo)

      issues.push(...batch.map(fromGitLabIssue))

      if (batch.length < PAGE)
        return issues
    }
  }

  if (provider === 'github') {
    const labelPart = labels === undefined ? '' : `&labels=${encodeURIComponent(labels)}`
    const milestonePart = milestone === undefined ? '' : `&milestone=${milestone}`

    for (let page = 1; ; page++) {
      const batch = await repoApi<GitHubIssueRaw[]>(`issues?state=${state}&per_page=${PAGE}&page=${page}${labelPart}${milestonePart}`, repo)

      issues.push(...batch.filter(each => each.pull_request === undefined).map(each => ({ ...each, body: each.body ?? '' })))

      if (batch.length < PAGE)
        return issues
    }
  }

  const filter = `${labels === undefined ? '' : `&labels=${encodeURIComponent(labels)}`}${milestone === undefined ? '' : `&milestones=${milestone}`}`

  for (let page = 1; ; page++) {
    const batch = await repoApi<Issue[]>(`issues?state=${state}&type=issues&page=${page}&limit=${PAGE}${filter}`, repo)

    issues.push(...batch)

    if (batch.length < PAGE)
      return issues
  }
}

// The open issues, narrowed to some labels and/or a milestone given by id.
export async function openIssues(labels: string | undefined, repo?: string, milestone?: number): Promise<Issue[]> {
  return listIssues('open', labels, repo, milestone)
}

export async function closedIssues(milestone: number, repo?: string): Promise<Issue[]> {
  return listIssues('closed', undefined, repo, milestone)
}

export async function commentsOf(number: number, repo?: string): Promise<IssueComment[]> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const notes = await repoApi<GitLabNoteRaw[]>(`issues/${number}/notes?per_page=100`, repo)

    return notes.filter(note => note.system !== true).map(note => ({
      body: note.body,
      created_at: note.created_at,
      user: { login: note.author?.username ?? 'unknown' },
    }))
  }

  return repoApi<IssueComment[]>(`issues/${number}/comments`, repo)
}

// Each issue's comments, an issue without any skipping the call.
export async function commentsOfAll(issues: Issue[], repo?: string): Promise<Map<number, IssueComment[]>> {
  const commented = issues.filter(issue => issue.comments > 0)
  const comments = await pool(commented, concurrencyOf(CONCURRENCY), async issue => commentsOf(issue.number, repo))

  return new Map(commented.map((issue, index) => [issue.number, comments[index]!]))
}

export async function editIssue(number: number, change: { title?: string, body?: string, milestone?: string }, repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const fields: Record<string, unknown> = {}

    if (change.title !== undefined)
      fields.title = change.title

    if (change.body !== undefined)
      fields.description = change.body

    if (change.milestone !== undefined)
      fields.milestone_id = await milestoneId(change.milestone, repo)

    await repoWrite('PUT', `issues/${number}`, fields, repo)

    return
  }

  if (provider === 'github') {
    const fields: Record<string, unknown> = {}

    if (change.title !== undefined)
      fields.title = change.title

    if (change.body !== undefined)
      fields.body = change.body

    if (change.milestone !== undefined)
      fields.milestone = change.milestone === '' ? null : (await findMilestone(change.milestone, repo)).id

    await repoWrite('PATCH', `issues/${number}`, fields, repo)

    return
  }

  await repoWrite('PATCH', `issues/${number}`, {
    ...change.title === undefined ? {} : { title: change.title },
    ...change.body === undefined ? {} : { body: change.body },
    ...change.milestone === undefined ? {} : { milestone: await milestoneId(change.milestone, repo) },
  }, repo)
}

export async function setBody(number: number, body: string, repo?: string): Promise<void> {
  await editIssue(number, { body }, repo)
}

export async function createIssue(title: string, body: string, labels: string | undefined, milestone: string | undefined, repo?: string): Promise<Issue> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const fields: Record<string, unknown> = { title, description: body }

    if (labels !== undefined)
      fields.labels = labels

    if (milestone !== undefined)
      fields.milestone_id = await milestoneId(milestone, repo)

    return fromGitLabIssue(await repoWrite<GitLabIssueRaw>('POST', 'issues', fields, repo))
  }

  if (provider === 'github') {
    const fields: Record<string, unknown> = { title, body }

    if (labels !== undefined)
      fields.labels = labels.split(',').map(each => each.trim()).filter(Boolean)

    if (milestone !== undefined)
      fields.milestone = (await findMilestone(milestone, repo)).id

    return repoWrite<Issue>('POST', 'issues', fields, repo)
  }

  return repoWrite<Issue>('POST', 'issues', {
    title,
    body,
    ...labels === undefined ? {} : { labels: await labelIds(labels.split(','), repo) },
    ...milestone === undefined ? {} : { milestone: await milestoneId(milestone, repo) },
  }, repo)
}

// Forges store a body with Unix line ends and may trim its end.
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

// The login the comments of this forge token carry, which is the only author a claim comment counts from; undefined when it cannot be read.
const cachedLogin = new Map<string, string>()

export async function sessionAuthor(repo?: string): Promise<string | undefined> {
  const target = await resolveForge(repo)
  const key = `${target.provider}:${target.apiBase}:${target.token ?? ''}`

  if (cachedLogin.has(key))
    return cachedLogin.get(key)

  try {
    const user = await api<{ login?: string, username?: string }>('user', repo)
    const login = user.login ?? user.username

    if (login !== undefined)
      cachedLogin.set(key, login)

    return login
  }
  catch {
    return undefined
  }
}

export async function comment(number: number, body: string, repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    await repoWrite('POST', `issues/${number}/notes`, { body }, repo)

    return
  }

  await repoWrite('POST', `issues/${number}/comments`, { body }, repo)
}

export async function close(number: number, repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return void await repoWrite('PUT', `issues/${number}`, { state_event: 'close' }, repo)

  await repoWrite('PATCH', `issues/${number}`, { state: 'closed' }, repo)
}

export async function reopen(number: number, repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return void await repoWrite('PUT', `issues/${number}`, { state_event: 'reopen' }, repo)

  await repoWrite('PATCH', `issues/${number}`, { state: 'open' }, repo)
}

export async function repoLabels(repo?: string): Promise<string[]> {
  const { provider } = await resolveForge(repo)
  const names: string[] = []
  const sizeParam = provider === 'forgejo' ? 'limit' : 'per_page'

  for (let page = 1; ; page++) {
    const batch = await repoApi<{ name: string }[]>(`labels?page=${page}&${sizeParam}=${PAGE}`, repo)

    names.push(...batch.map(each => each.name))

    if (batch.length < PAGE)
      return names
  }
}

export async function editLabels(number: number, add: string[], remove: string[], repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const fields: Record<string, unknown> = {}

    if (add.length > 0)
      fields.add_labels = add.join(',')

    if (remove.length > 0)
      fields.remove_labels = remove.join(',')

    await repoWrite('PUT', `issues/${number}`, fields, repo)

    return
  }

  if (provider === 'github') {
    if (add.length > 0)
      await repoSend('POST', `issues/${number}/labels`, { labels: add }, repo)

    for (const name of remove)
      await repoSend('DELETE', `issues/${number}/labels/${encodeURIComponent(name)}`, {}, repo)

    return
  }

  if (add.length > 0)
    await repoSend('POST', `issues/${number}/labels`, { labels: await labelIds(add, repo) }, repo)

  for (const id of await labelIds(remove, repo))
    await repoSend('DELETE', `issues/${number}/labels/${id}`, {}, repo)
}

// The ids of labels given by name, which Forgejo's API takes.
async function labelIds(names: string[], repo?: string): Promise<number[]> {
  const all: { id: number, name: string }[] = []

  for (let page = 1; ; page++) {
    const batch = await repoApi<{ id: number, name: string }[]>(`labels?page=${page}&limit=${PAGE}`, repo)

    all.push(...batch)

    if (batch.length < PAGE)
      break
  }

  return names.map(name => name.trim()).filter(name => name !== '').map((name) => {
    const found = all.find(each => each.name === name)

    if (found === undefined)
      throw new Error(`no label ${name}, the repository has: ${all.map(each => each.name).join(', ')}`)

    return found.id
  })
}

// A milestone's id from its title; an empty one is 0, which clears it.
async function milestoneId(title: string, repo?: string): Promise<number> {
  return title === '' ? 0 : (await findMilestone(title, repo)).id
}
