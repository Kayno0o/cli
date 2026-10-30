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

export async function recentPipelines(limit: number, repo?: string, ref?: string): Promise<Pipeline[]> {
  return projectApi<Pipeline[]>(`pipelines?per_page=${Math.min(limit, PAGE)}${ref === undefined ? '' : `&ref=${encodeURIComponent(ref)}`}`, repo)
}

export async function pipelinesOn(sha: string, repo?: string, ref?: string): Promise<Pipeline[]> {
  return projectApi<Pipeline[]>(`pipelines?sha=${sha}&per_page=${PAGE}${ref === undefined ? '' : `&ref=${encodeURIComponent(ref)}`}`, repo)
}

export async function pipelineById(id: number, repo?: string): Promise<Pipeline> {
  return projectApi<Pipeline>(`pipelines/${id}`, repo)
}

export async function jobsOf(pipeline: number, repo?: string): Promise<Job[]> {
  return projectApi<Job[]>(`pipelines/${pipeline}/jobs?per_page=${PAGE}`, repo)
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
