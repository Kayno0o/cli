import { ciLine, formatSeconds, hyperlink } from '@kaynooo/cli-kit'
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

// `in 3m 2s` once a pipeline is over, `for 1m 12s` while it runs, nothing before a second has passed.
function elapsedOf(pipeline: Pipeline): string | undefined {
  if (FINISHED.has(pipeline.status))
    return (pipeline.duration ?? 0) > 0 ? `in ${formatSeconds(pipeline.duration!)}` : undefined

  const seconds = Math.floor((Date.now() - Date.parse(pipeline.started_at ?? '')) / 1000)

  return seconds > 0 ? `for ${formatSeconds(seconds)}` : undefined
}

// The line every watcher of pipelines draws for one, the same shape ft draws for a run.
export function pipelineLine(pipeline: Pipeline, out: { isTTY?: boolean }, ref = pipeline.ref): string {
  return ciLine(pipeline.status, 'pipeline', [hyperlink(String(pipeline.id), pipeline.web_url, out), `on ${ref}`, elapsedOf(pipeline)], out)
}

const PAGE = 100
const JSON_STATUS: Record<string, string> = { failed: 'failure', canceled: 'cancelled' }

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

// Retries the failed jobs of a pipeline, which GitLab answers with the pipeline running again.
export async function retryPipeline(id: number, repo?: string): Promise<Pipeline> {
  return projectApi<Pipeline>(`pipelines/${id}/retry`, repo, 'POST')
}

export async function retryJob(id: number, repo?: string): Promise<Job> {
  return projectApi<Job>(`jobs/${id}/retry`, repo, 'POST')
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

export interface FailedJob { name: string, stage: string, reason: string | null, url: string, excerpt: string }

// Each failed job of the pipeline, with what its trace says went wrong.
export async function failedJobsOf(pipeline: Pipeline, repo?: string): Promise<FailedJob[]> {
  const failed: FailedJob[] = []

  for (const job of failedJobs(await jobsOf(pipeline.id, repo)))
    failed.push({ name: job.name, stage: job.stage, reason: job.failure_reason ?? null, url: job.web_url, excerpt: excerpt(await jobTrace(job.id, repo)) })

  return failed
}

export function failureText(failed: FailedJob[]): string {
  return failed.map(job => `job ${job.name} (${job.stage}) failed${job.reason === null || job.reason === 'script_failure' ? '' : `, ${job.reason}`}: ${job.url}\n${job.excerpt}`).join('\n\n')
}

// GitLab's statuses under the names `ft` prints, so a script reads both alike; the others (running, pending, manual...) are kept.
export function jsonStatus(status: string): string {
  return JSON_STATUS[status] ?? status
}

export function pipelineJson(pipeline: Pipeline) {
  return { id: pipeline.id, number: pipeline.iid, status: jsonStatus(pipeline.status), ref: pipeline.ref, sha: pipeline.sha, url: pipeline.web_url }
}

// What a --json wait or log prints, shaped like `ft ci --json`: the pipeline's status, the pipeline followed, the failed jobs with their excerpts and its link.
export function ciJson(pipeline: Pipeline, failed: FailedJob[]) {
  return { status: jsonStatus(pipeline.status), runs: [pipelineJson(pipeline)], failedJobs: failed, url: pipeline.web_url }
}
