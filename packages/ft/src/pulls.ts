import type { IssueComment } from './issues'
import { repoApi, repoApiText, repoSend, repoWrite, resolveForge } from './tea'

export interface PullRequest {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string
  head: string
  base: string
  html_url: string
  created_at: string
  updated_at: string
  mergeable?: boolean | null | undefined
}

interface ForgejoGitHubPullRaw {
  number: number
  title: string
  body?: string | null
  state: string
  draft?: boolean
  merged?: boolean
  merged_at?: string | null
  user?: { login: string }
  head?: { ref?: string, label?: string }
  base?: { ref?: string, label?: string }
  html_url: string
  created_at?: string
  updated_at?: string
  mergeable?: boolean | null
}

interface GitLabMrRaw {
  iid: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  work_in_progress?: boolean
  author?: { username: string }
  source_branch: string
  target_branch: string
  web_url: string
  created_at?: string
  updated_at?: string
  merge_status?: string
}

interface GitLabNoteRaw {
  body: string
  created_at: string
  system?: boolean
  author?: { username: string }
}

function fromForgejoOrGitHub(raw: ForgejoGitHubPullRaw): PullRequest {
  const merged = raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null && raw.merged_at !== '')
  let state: PullRequest['state'] = 'open'

  if (merged)
    state = 'merged'
  else if (raw.state === 'closed')
    state = 'closed'

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state,
    draft: raw.draft === true,
    author: raw.user?.login ?? 'unknown',
    head: raw.head?.ref ?? raw.head?.label ?? '',
    base: raw.base?.ref ?? raw.base?.label ?? '',
    html_url: raw.html_url,
    created_at: raw.created_at ?? '',
    updated_at: raw.updated_at ?? '',
    mergeable: raw.mergeable,
  }
}

function fromGitLab(raw: GitLabMrRaw): PullRequest {
  let state: PullRequest['state'] = 'open'

  if (raw.state === 'merged')
    state = 'merged'
  else if (raw.state === 'closed')
    state = 'closed'

  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? '',
    state,
    draft: raw.draft === true || raw.work_in_progress === true,
    author: raw.author?.username ?? 'unknown',
    head: raw.source_branch,
    base: raw.target_branch,
    html_url: raw.web_url,
    created_at: raw.created_at ?? '',
    updated_at: raw.updated_at ?? '',
    mergeable: raw.merge_status === undefined ? undefined : raw.merge_status === 'can_be_merged',
  }
}

const PAGE = 50

export async function listPulls(options: { state?: 'open' | 'closed' | 'all', base?: string | undefined, author?: string | undefined, limit?: number, repo?: string | undefined } = {}): Promise<PullRequest[]> {
  const { state = 'open', base, author, limit = 30, repo } = options
  const { provider } = await resolveForge(repo)
  const pulls: PullRequest[] = []

  if (provider === 'gitlab') {
    const glState = state === 'open' ? 'opened' : state
    const basePart = base === undefined ? '' : `&target_branch=${encodeURIComponent(base)}`
    const authorPart = author === undefined ? '' : `&author_username=${encodeURIComponent(author)}`

    for (let page = 1; pulls.length < limit; page++) {
      const batch = await repoApi<GitLabMrRaw[]>(`merge_requests?state=${glState}&per_page=${PAGE}&page=${page}${basePart}${authorPart}`, repo)

      pulls.push(...batch.map(fromGitLab))

      if (batch.length < PAGE)
        break
    }

    return pulls.slice(0, limit)
  }

  const sizeParam = provider === 'github' ? 'per_page' : 'limit'
  const basePart = base === undefined ? '' : `&base=${encodeURIComponent(base)}`

  for (let page = 1; pulls.length < limit; page++) {
    const batch = await repoApi<ForgejoGitHubPullRaw[]>(`pulls?state=${state}&page=${page}&${sizeParam}=${PAGE}${basePart}`, repo)
    const mapped = batch.map(fromForgejoOrGitHub).filter(pr => author === undefined || pr.author.toLowerCase() === author.toLowerCase())

    pulls.push(...mapped)

    if (batch.length < PAGE)
      break
  }

  return pulls.slice(0, limit)
}

export async function getPull(number: number, repo?: string): Promise<PullRequest> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return fromGitLab(await repoApi<GitLabMrRaw>(`merge_requests/${number}`, repo))

  return fromForgejoOrGitHub(await repoApi<ForgejoGitHubPullRaw>(`pulls/${number}`, repo))
}

export async function pullComments(number: number, repo?: string): Promise<IssueComment[]> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const notes = await repoApi<GitLabNoteRaw[]>(`merge_requests/${number}/notes?per_page=100`, repo)

    return notes.filter(note => note.system !== true).map(note => ({
      body: note.body,
      created_at: note.created_at,
      user: { login: note.author?.username ?? 'unknown' },
    }))
  }

  return repoApi<IssueComment[]>(`issues/${number}/comments`, repo)
}

export async function pullDiff(number: number, repo?: string): Promise<string> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const changes = await repoApi<{ changes?: { old_path: string, new_path: string, diff: string }[] }>(`merge_requests/${number}/changes`, repo)

    return (changes.changes ?? []).map(each => `--- a/${each.old_path}\n+++ b/${each.new_path}\n${each.diff}`).join('\n')
  }

  return repoApiText(`pulls/${number}.diff`, repo)
}

export async function createPull(input: { title: string, body: string, head: string, base: string, draft?: boolean, repo?: string | undefined }): Promise<PullRequest> {
  const { provider } = await resolveForge(input.repo)

  if (provider === 'gitlab') {
    const title = input.draft === true && !input.title.startsWith('Draft:') ? `Draft: ${input.title}` : input.title

    return fromGitLab(await repoWrite<GitLabMrRaw>('POST', 'merge_requests', {
      title,
      description: input.body,
      source_branch: input.head,
      target_branch: input.base,
    }, input.repo))
  }

  const title = provider === 'forgejo' && input.draft === true && !input.title.startsWith('WIP:') ? `WIP: ${input.title}` : input.title

  return fromForgejoOrGitHub(await repoWrite<ForgejoGitHubPullRaw>('POST', 'pulls', {
    title,
    body: input.body,
    head: input.head,
    base: input.base,
    ...provider === 'github' && input.draft === true ? { draft: true } : {},
  }, input.repo))
}

export async function mergePull(number: number, options: { method: 'merge' | 'squash' | 'rebase', deleteBranch?: boolean, repo?: string | undefined }): Promise<void> {
  const { provider } = await resolveForge(options.repo)

  if (provider === 'gitlab') {
    await repoWrite('PUT', `merge_requests/${number}/merge`, {
      squash: options.method === 'squash',
      should_remove_source_branch: options.deleteBranch === true,
    }, options.repo)

    return
  }

  if (provider === 'github') {
    await repoWrite('PUT', `pulls/${number}/merge`, { merge_method: options.method }, options.repo)

    if (options.deleteBranch === true) {
      const pr = await getPull(number, options.repo)

      if (pr.head !== '')
        await repoSend('DELETE', `git/refs/heads/${encodeURIComponent(pr.head)}`, {}, options.repo)
    }

    return
  }

  // Forgejo
  await repoSend('POST', `pulls/${number}/merge`, {
    Do: options.method,
    delete_branch_after_merge: options.deleteBranch === true,
  }, options.repo)
}

export async function pullFetchRef(number: number, repo?: string): Promise<string> {
  const { provider } = await resolveForge(repo)

  return provider === 'gitlab' ? `merge-requests/${number}/head` : `pull/${number}/head`
}
