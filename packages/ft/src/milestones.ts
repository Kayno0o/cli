import { fail, runHint } from '@kaynooo/cli-kit'
import { repoApi, repoWrite, resolveForge } from './tea'

export interface Milestone { id: number, title: string, description: string, state: string, open_issues: number, closed_issues: number, due_on: string | null }

interface GitHubMilestoneRaw {
  number: number
  title: string
  description: string | null
  state: string
  open_issues: number
  closed_issues: number
  due_on: string | null
}

interface GitLabMilestoneRaw {
  id: number
  title: string
  description: string | null
  state: string
  due_date: string | null
}

const PAGE = 50
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// Forgejo shows a due date in year 9999 as "no due date".
const NO_DUE_YEAR = 9999

function fromGitHub(raw: GitHubMilestoneRaw): Milestone {
  return {
    id: raw.number,
    title: raw.title,
    description: raw.description ?? '',
    state: raw.state,
    open_issues: raw.open_issues,
    closed_issues: raw.closed_issues,
    due_on: raw.due_on,
  }
}

function fromGitLab(raw: GitLabMilestoneRaw): Milestone {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description ?? '',
    state: raw.state === 'active' ? 'open' : 'closed',
    open_issues: 0,
    closed_issues: 0,
    due_on: raw.due_date,
  }
}

export async function listMilestones(state: 'open' | 'closed' | 'all', repo?: string): Promise<Milestone[]> {
  const { provider } = await resolveForge(repo)
  const found: Milestone[] = []

  if (provider === 'gitlab') {
    const stateParam = state === 'all' ? '' : `&state=${state === 'open' ? 'active' : 'closed'}`

    for (let page = 1; ; page++) {
      const batch = await repoApi<GitLabMilestoneRaw[]>(`milestones?per_page=${PAGE}&page=${page}${stateParam}`, repo)

      found.push(...batch.map(fromGitLab))

      if (batch.length < PAGE)
        return found
    }
  }

  if (provider === 'github') {
    for (let page = 1; ; page++) {
      const batch = await repoApi<GitHubMilestoneRaw[]>(`milestones?state=${state}&per_page=${PAGE}&page=${page}`, repo)

      found.push(...batch.map(fromGitHub))

      if (batch.length < PAGE)
        return found
    }
  }

  for (let page = 1; ; page++) {
    const batch = await repoApi<Milestone[]>(`milestones?state=${state}&page=${page}&limit=${PAGE}`, repo)

    found.push(...batch)

    if (batch.length < PAGE)
      return found
  }
}

// A milestone named by its title or, failing that, by its id.
export async function findMilestone(reference: string, repo?: string): Promise<Milestone> {
  const all = await listMilestones('all', repo)
  const found = all.find(each => each.title === reference) ?? all.find(each => String(each.id) === reference)

  if (found === undefined)
    fail(`no milestone ${reference}, ${all.length === 0 ? 'the repository has none' : `it has: ${all.map(each => each.title).join(', ')}`}`, 2, runHint(`ft milestone new ${reference}`, 'create it'))

  return found
}

// The date forges take, from YYYY-MM-DD; a zero or malformed one is refused.
export function dueOn(value: string): string {
  const match = DATE.exec(value)
  const date = new Date(`${value}T00:00:00Z`)

  if (match === null || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCFullYear() < 2000)
    fail(`--due takes a date as YYYY-MM-DD, not ${value}`)

  return date.toISOString()
}

// The due date as YYYY-MM-DD, or an empty string when none is set.
export function dueDate(milestone: Milestone): string {
  if (milestone.due_on === null || new Date(milestone.due_on).getUTCFullYear() >= NO_DUE_YEAR)
    return ''

  return milestone.due_on.slice(0, 10)
}

// Rounded down, so it reads 100% only once every issue is closed.
export function progress(milestone: Milestone): string {
  const total = milestone.open_issues + milestone.closed_issues

  return total === 0 ? '' : `${Math.floor(milestone.closed_issues * 100 / total)}%`
}

export async function createMilestone(title: string, description: string | undefined, due: string | undefined, repo?: string): Promise<Milestone> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const fields: Record<string, string> = { title }

    if (description !== undefined)
      fields.description = description

    if (due !== undefined)
      fields.due_date = due.slice(0, 10)

    return fromGitLab(await repoWrite<GitLabMilestoneRaw>('POST', 'milestones', fields, repo))
  }

  const fields: Record<string, string> = { title }

  if (description !== undefined)
    fields.description = description

  if (due !== undefined)
    fields.due_on = due

  if (provider === 'github')
    return fromGitHub(await repoWrite<GitHubMilestoneRaw>('POST', 'milestones', fields, repo))

  return repoWrite<Milestone>('POST', 'milestones', fields, repo)
}

export async function closeMilestone(id: number, repo?: string): Promise<void> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    await repoWrite('PUT', `milestones/${id}`, { state_event: 'close' }, repo)

    return
  }

  await repoWrite('PATCH', `milestones/${id}`, { state: 'closed' }, repo)
}
