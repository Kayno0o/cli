import { fail, runHint } from '@kaynooo/cli-kit'
import { repoApi, repoWrite } from './tea'

export interface Milestone { id: number, title: string, description: string, state: string, open_issues: number, closed_issues: number, due_on: string | null }

const PAGE = 50
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// Forgejo shows a due date in year 9999 as "no due date".
const NO_DUE_YEAR = 9999

export async function listMilestones(state: 'open' | 'closed' | 'all', repo?: string): Promise<Milestone[]> {
  const found: Milestone[] = []

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

// The date Forgejo takes, from YYYY-MM-DD; a zero or malformed one is refused, as Forgejo would store year 1 as 01/01/0001.
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

export function progress(milestone: Milestone): string {
  const total = milestone.open_issues + milestone.closed_issues

  return total === 0 ? '' : `${Math.round(milestone.closed_issues / total * 100)}%`
}

export async function createMilestone(title: string, description: string | undefined, due: string | undefined, repo?: string): Promise<Milestone> {
  const fields: Record<string, string> = { title }

  if (description !== undefined)
    fields.description = description

  if (due !== undefined)
    fields.due_on = due

  return repoWrite<Milestone>('POST', 'milestones', fields, repo)
}

export async function closeMilestone(id: number, repo?: string): Promise<void> {
  await repoWrite('PATCH', `milestones/${id}`, { state: 'closed' }, repo)
}
