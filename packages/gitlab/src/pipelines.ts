import { projectApi, projectApiText } from './glab'
import { excerpt } from './trace'

// The fields of GitLab's pipeline: the list leaves out duration and the start, which only the single pipeline carries.
export interface Pipeline {
  id: number
  iid: number
  sha: string
  ref: string
  status: string
  source: string
  created_at: string
  updated_at: string
  web_url: string
  duration?: number | null
  started_at?: string | null
}

export interface Job {
  id: number
  name: string
  stage: string
  status: string
  allow_failure: boolean
  failure_reason?: string
  tag_list: string[]
  web_url: string
}

// A manual pipeline waits on a job nobody has played, its earlier stages done.
export const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])
const PAGE = 100

// A list read page by page, GitLab capping a page at 100, until a short page ends it or `enough` items were read (an infinite one reads them all); `exhausted` is false when it stopped with more possibly left.
async function pagedList<T>(path: string, repo: string | undefined, enough = Number.POSITIVE_INFINITY): Promise<{ items: T[], exhausted: boolean }> {
  const items: T[] = []
  const joiner = path.includes('?') ? '&' : '?'

  for (let page = 1; ; page++) {
    const list = await projectApi<T[]>(`${path}${joiner}per_page=${PAGE}&page=${page}`, repo)

    items.push(...list)

    if (list.length < PAGE)
      return { items, exhausted: true }

    if (items.length > enough)
      return { items, exhausted: false }
  }
}

const pipelinesPath = (filters: string[]) => `pipelines${filters.length === 0 ? '' : `?${filters.join('&')}`}`

export interface PipelineListing {
  pipelines: Pipeline[]
  // How many more pipelines the listing left out, at least that many when `exact` is false.
  more: number
  exact: boolean
}

// The newest pipelines, `limit` of them, paged since GitLab caps a page (an infinite limit reads them all), with how many were left out.
export async function recentPipelines(limit: number, repo?: string, ref?: string): Promise<PipelineListing> {
  const { items, exhausted } = await pagedList<Pipeline>(pipelinesPath(ref === undefined ? [] : [`ref=${encodeURIComponent(ref)}`]), repo, limit)

  return { pipelines: items.slice(0, limit), more: Math.max(0, items.length - limit), exact: exhausted }
}

// Every pipeline of a commit, paged since GitLab caps a page.
export async function pipelinesOn(sha: string, repo?: string, ref?: string): Promise<Pipeline[]> {
  return (await pagedList<Pipeline>(pipelinesPath([`sha=${sha}`, ...ref === undefined ? [] : [`ref=${encodeURIComponent(ref)}`]]), repo)).items
}

export async function pipelineById(id: number, repo?: string): Promise<Pipeline> {
  return projectApi<Pipeline>(`pipelines/${id}`, repo)
}

export async function jobsOf(pipeline: number, repo?: string): Promise<Job[]> {
  return (await pagedList<Job>(`pipelines/${pipeline}/jobs`, repo)).items
}

export async function jobTrace(job: number, repo?: string): Promise<string> {
  return projectApiText(`jobs/${job}/trace`, repo)
}

// The pipeline as it stands now, or undefined when it cannot be read.
export async function refreshed(id: number): Promise<Pipeline | undefined> {
  try {
    return await pipelineById(id)
  }
  catch {
    return undefined
  }
}

// The newest pipeline among those of a commit, which a retry or a new push supersedes.
export function newest(pipelines: Pipeline[]): Pipeline | undefined {
  return pipelines.reduce<Pipeline | undefined>((kept, pipeline) => (kept === undefined || pipeline.id > kept.id ? pipeline : kept), undefined)
}

// A failed job that may fail leaves the pipeline green, so only the others are what went wrong.
export function failedJobs(jobs: Job[]): Job[] {
  return jobs.filter(job => job.status === 'failed' && !job.allow_failure)
}

// Jobs waiting for a runner while none of the pipeline's runs, which means no runner takes them when it lasts.
export function waitingOnRunner(jobs: Job[]): Job[] {
  return jobs.some(job => job.status === 'running') ? [] : jobs.filter(job => job.status === 'pending')
}

// Each failed job of the pipeline, with what its trace says went wrong.
export async function failureReport(pipeline: Pipeline, repo?: string): Promise<string> {
  const parts: string[] = []

  for (const job of failedJobs(await jobsOf(pipeline.id, repo)))
    parts.push(`job ${job.name} (${job.stage}) failed${job.failure_reason === undefined || job.failure_reason === 'script_failure' ? '' : `, ${job.failure_reason}`}: ${job.web_url}\n${excerpt(await jobTrace(job.id, repo))}`)

  return parts.join('\n\n')
}
