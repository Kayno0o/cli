import { ciLine, formatAge, formatSeconds, hyperlink } from '@kaynooo/cli-kit'
import { excerpt } from './log'
import { api, repoApi, repoApiText } from './tea'

// The fields Forgejo 15's ActionRun sends, which tea's own run views fail to decode.
export interface Run {
  id: number
  index_in_repo: number
  title: string
  commit_sha: string
  event: string
  html_url: string
  status: string
  workflow_id: string
  prettyref: string
  started: string
  stopped: string
  duration: number
}

export interface Job { id: number, name: string, status: string, runs_on: string[] | null }

interface Runner { name: string, status: string, labels: string[] | null }

export const FINISHED = new Set(['success', 'failure', 'skipped', 'cancelled'])
export const QUEUED = new Set(['waiting', 'blocked'])
const NANOSECONDS = 1e9
const EPOCH = Date.parse('2000-01-01T00:00:00Z')

export function runSeconds(run: Run): number {
  return run.duration / NANOSECONDS
}

// When the run started, undefined while it has not: Forgejo then gives its zero time, year 1.
export function startedAt(run: Run): number | undefined {
  const at = Date.parse(run.started)

  return Number.isNaN(at) || at < EPOCH ? undefined : at
}

// `in 3m 2s` once a run is over, `for 1m 12s` while it runs or waits (from `seen` when Forgejo has not started it), nothing before a second has passed.
function elapsed(run: Run, seen: number): string | undefined {
  if (FINISHED.has(run.status))
    return run.duration > 0 ? `in ${formatSeconds(runSeconds(run))}` : undefined

  const seconds = Math.floor((Date.now() - (startedAt(run) ?? seen)) / 1000)

  return seconds > 0 ? `for ${formatSeconds(seconds)}` : undefined
}

// The line every watcher of runs draws for one, shared with the pipelines of gl through the kit.
export function runLine(run: Run, out: { isTTY?: boolean }, seen = Date.now(), ref = run.prettyref): string {
  return ciLine(run.status, run.workflow_id, [`run ${hyperlink(String(run.id), run.html_url, out)}`, `on ${ref}`, elapsed(run, seen)], out)
}

export function startedAge(run: Run, now = Date.now()): string {
  return startedAt(run) === undefined ? '-' : formatAge(run.started, now)
}

const RUNS_PAGE = 50

// The newest runs, `limit` of them, paged since Forgejo caps a page (an infinite limit reads them all), with how many the repository holds.
export async function runsListing(limit: number, repo?: string, workflow?: string): Promise<{ runs: Run[], total: number }> {
  const filter = workflow === undefined ? '' : `&workflow_id=${encodeURIComponent(workflow)}`
  const runs: Run[] = []
  let total = 0

  for (let page = 1; runs.length < limit; page++) {
    const found = await repoApi<{ workflow_runs: Run[] | null, total_count?: number }>(`actions/runs?page=${page}&limit=${RUNS_PAGE}${filter}`, repo)
    const list = found.workflow_runs ?? []

    runs.push(...list)
    total = found.total_count ?? 0

    if (list.length < RUNS_PAGE)
      break
  }

  return { runs: runs.slice(0, limit), total: Math.max(total, runs.length) }
}

export async function recentRuns(limit: number, repo?: string, workflow?: string): Promise<Run[]> {
  return (await runsListing(limit, repo, workflow)).runs
}

// Every run of a commit, paged since Forgejo caps a page, so the newest per workflow is picked from the whole list.
export async function runsOn(sha: string, repo?: string): Promise<Run[]> {
  const runs: Run[] = []

  for (let page = 1; ; page++) {
    const list = (await repoApi<{ workflow_runs: Run[] | null }>(`actions/runs?head_sha=${sha}&page=${page}&limit=${RUNS_PAGE}`, repo)).workflow_runs ?? []

    runs.push(...list)

    if (list.length < RUNS_PAGE)
      return runs
  }
}

export async function runById(id: number, repo?: string): Promise<Run> {
  return repoApi<Run>(`actions/runs/${id}`, repo)
}

export async function jobsOf(run: number, repo?: string): Promise<Job[]> {
  return repoApi<Job[]>(`actions/runs/${run}/jobs`, repo)
}

export async function jobLog(job: number, repo?: string): Promise<string> {
  return repoApiText(`actions/jobs/${job}/logs`, repo)
}

// The runs as they stand now, or undefined when they cannot be read.
export async function refreshed(runs: Run[], repo?: string): Promise<Run[] | undefined> {
  try {
    return await Promise.all(runs.map(async run => runById(run.id, repo)))
  }
  catch {
    return undefined
  }
}

// The newest push run of each workflow, or of the one asked for.
export function newestPerWorkflow(runs: Run[], workflow?: string): Run[] {
  const newest = new Map<string, Run>()

  for (const run of runs) {
    if (run.event !== 'push' || (workflow !== undefined && run.workflow_id !== workflow))
      continue

    const kept = newest.get(run.workflow_id)

    if (kept === undefined || run.id > kept.id)
      newest.set(run.workflow_id, run)
  }

  return [...newest.values()].sort((a, b) => a.workflow_id.localeCompare(b.workflow_id))
}

// The worst status among runs: a failure first, then anything unfinished, then success over skipped.
export function overall(runs: Run[]): string {
  const statuses = new Set(runs.map(run => run.status))

  for (const status of ['failure', 'cancelled']) {
    if (statuses.has(status))
      return status
  }

  const pending = runs.find(run => !FINISHED.has(run.status))

  if (pending !== undefined)
    return pending.status

  return statuses.has('success') ? 'success' : 'skipped'
}

export interface Stall { reason: string, certain: boolean }

// Why the queued runs are not moving, certain when no online runner carries a job's labels; undefined when it cannot tell, as the runner list needs an admin login.
export async function stallReason(runs: Run[], repo?: string): Promise<Stall | undefined> {
  const queued = runs.filter(run => QUEUED.has(run.status))

  if (queued.length === 0)
    return undefined

  let runners: Runner[]

  try {
    runners = await api<Runner[]>('admin/actions/runners')
  }
  catch {
    return undefined
  }

  const online = runners.filter(runner => runner.status !== 'offline')

  if (online.length === 0)
    return { reason: runners.length === 0 ? 'no runner is registered' : `every runner is offline (${runners.map(runner => runner.name).join(', ')})`, certain: false }

  for (const run of queued) {
    for (const job of await jobsOf(run.id, repo)) {
      const labels = job.runs_on ?? []

      if (QUEUED.has(job.status) && !online.some(runner => labels.every(label => (runner.labels ?? []).includes(label))))
        return { reason: `job ${job.name} of ${run.workflow_id} runs on ${labels.join(', ')}, which no online runner carries (${online.map(runner => `${runner.name}: ${(runner.labels ?? []).join(', ')}`).join('; ')})`, certain: true }
    }
  }

  return online.some(runner => runner.status === 'active') ? undefined : { reason: 'no runner is working on anything: is it up?', certain: false }
}

export interface FailedJob { name: string, run: number, workflow: string, excerpt: string }

// Each failed job of the run, with what its log says went wrong.
export async function failedJobsOf(run: Run, repo?: string): Promise<FailedJob[]> {
  const failed: FailedJob[] = []

  for (const job of await jobsOf(run.id, repo)) {
    if (job.status === 'failure')
      failed.push({ name: job.name, run: run.id, workflow: run.workflow_id, excerpt: excerpt(await jobLog(job.id, repo)) })
  }

  return failed
}

export function failureText(failed: FailedJob[]): string {
  return failed.map(job => `job ${job.name} of ${job.workflow} failed:\n${job.excerpt}`).join('\n\n')
}

export async function failureReport(run: Run, repo?: string): Promise<string> {
  return failureText(await failedJobsOf(run, repo))
}

export function runJson(run: Run) {
  return { id: run.id, workflow: run.workflow_id, status: run.status, ref: run.prettyref, sha: run.commit_sha, url: run.html_url }
}

// What a --json wait or log prints: the worst status, the runs followed, the failed jobs with their excerpts, and the link to the failed run, else the first.
export function ciJson(runs: Run[], failedJobs: FailedJob[]) {
  const link = runs.find(run => run.status === 'failure') ?? runs[0]

  return { status: runs.length === 0 ? 'none' : overall(runs), runs: runs.map(runJson), failedJobs, url: link?.html_url ?? null }
}
