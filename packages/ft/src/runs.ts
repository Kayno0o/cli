import { ciLine, formatAge, formatSeconds, hyperlink, role } from '@kaynooo/cli-kit'
import { excerpt } from './log'
import { api, repoApi, repoApiText, repoSend, repoWriteOrEmpty, resolveForge } from './tea'

// Normalized CI run across Forgejo Actions, GitHub Actions, and GitLab Pipelines.
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

export interface Job {
  id: number
  name: string
  status: string
  runs_on: string[] | null
  stage?: string | undefined
  allow_failure?: boolean | undefined
  html_url?: string | undefined
}

interface Runner { name: string, status: string, labels: string[] | null }

interface GitHubRunRaw {
  id: number
  run_number?: number
  display_title?: string
  name?: string
  path?: string
  head_sha: string
  event: string
  html_url: string
  status: string
  conclusion?: string | null
  head_branch?: string | null
  run_started_at?: string | null
  created_at?: string
  updated_at?: string
}

interface GitHubJobRaw {
  id: number
  name: string
  status: string
  conclusion?: string | null
  labels?: string[]
  html_url?: string
}

interface GitLabPipelineRaw {
  id: number
  iid?: number
  sha: string
  ref: string
  status: string
  source?: string
  created_at?: string
  started_at?: string | null
  updated_at?: string
  web_url: string
  duration?: number | null
}

interface GitLabJobRaw {
  id: number
  name: string
  stage?: string
  status: string
  allow_failure?: boolean
  tag_list?: string[]
  web_url?: string
}

export const FINISHED = new Set(['success', 'failure', 'skipped', 'cancelled', 'manual'])
export const QUEUED = new Set(['waiting', 'blocked', 'queued', 'pending'])
const NANOSECONDS = 1e9
const EPOCH = Date.parse('2000-01-01T00:00:00Z')

function normalizeGitHubStatus(status: string, conclusion?: string | null): string {
  if (status === 'completed') {
    if (conclusion === 'success')
      return 'success'

    if (conclusion === 'cancelled')
      return 'cancelled'

    return conclusion === 'skipped' || conclusion === 'neutral' ? 'skipped' : 'failure'
  }

  if (status === 'in_progress')
    return 'running'

  if (status === 'queued' || status === 'requested' || status === 'pending' || status === 'waiting')
    return 'waiting'

  return status
}

function normalizeGitLabStatus(status: string): string {
  if (status === 'failed')
    return 'failure'

  if (status === 'canceled')
    return 'cancelled'

  if (status === 'pending' || status === 'created' || status === 'waiting_for_resource' || status === 'preparing')
    return 'waiting'

  return status
}

function fromGitHubRun(raw: GitHubRunRaw): Run {
  const started = raw.run_started_at ?? raw.created_at ?? ''
  const stopped = raw.updated_at ?? ''
  const startedMs = Date.parse(started)
  const stoppedMs = Date.parse(stopped)
  const duration = !Number.isNaN(startedMs) && !Number.isNaN(stoppedMs) && stoppedMs > startedMs && raw.status === 'completed'
    ? (stoppedMs - startedMs) * 1e6
    : 0
  const workflowFile = raw.path?.split('/').at(-1) ?? raw.name ?? 'workflow'

  return {
    id: raw.id,
    index_in_repo: raw.run_number ?? raw.id,
    title: raw.display_title ?? raw.name ?? '',
    commit_sha: raw.head_sha,
    event: raw.event,
    html_url: raw.html_url,
    status: normalizeGitHubStatus(raw.status, raw.conclusion),
    workflow_id: workflowFile,
    prettyref: raw.head_branch ?? '',
    started,
    stopped,
    duration,
  }
}

function fromGitLabPipeline(raw: GitLabPipelineRaw): Run {
  return {
    id: raw.id,
    index_in_repo: raw.iid ?? raw.id,
    title: raw.source ?? 'pipeline',
    commit_sha: raw.sha,
    event: raw.source ?? 'push',
    html_url: raw.web_url,
    status: normalizeGitLabStatus(raw.status),
    workflow_id: 'pipeline',
    prettyref: raw.ref,
    started: raw.started_at ?? raw.created_at ?? '',
    stopped: raw.updated_at ?? '',
    duration: (raw.duration ?? 0) * NANOSECONDS,
  }
}

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

// The line every watcher of runs draws for one.
export function runLine(run: Run, out: { isTTY?: boolean }, seen = Date.now(), ref = run.prettyref): string {
  return ciLine(run.status, run.workflow_id, [`run ${hyperlink(String(run.id), run.html_url, out)}`, `on ${ref}`, elapsed(run, seen)], out)
}

export function startedAge(run: Run, now = Date.now()): string {
  return startedAt(run) === undefined ? '-' : formatAge(run.started, now)
}

const RUNS_PAGE = 50
const GITLAB_PAGE = 100

// The newest runs, `limit` of them, paged since forges cap a page, with how many the repository holds.
export async function runsListing(limit: number, repo?: string, workflow?: string): Promise<{ runs: Run[], total: number }> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const runs: Run[] = []

    for (let page = 1; runs.length < limit; page++) {
      const list = await repoApi<GitLabPipelineRaw[]>(`pipelines?per_page=${GITLAB_PAGE}&page=${page}`, repo)

      runs.push(...list.map(fromGitLabPipeline))

      if (list.length < GITLAB_PAGE)
        break
    }

    return { runs: runs.slice(0, limit), total: runs.length }
  }

  if (provider === 'github') {
    const runs: Run[] = []
    let total = 0
    const basePath = workflow === undefined ? 'actions/runs' : `actions/workflows/${encodeURIComponent(workflow)}/runs`

    for (let page = 1; runs.length < limit; page++) {
      const found = await repoApi<{ workflow_runs?: GitHubRunRaw[], total_count?: number }>(`${basePath}?page=${page}&per_page=${RUNS_PAGE}`, repo)
      const list = (found.workflow_runs ?? []).map(fromGitHubRun)

      runs.push(...list)
      total = found.total_count ?? 0

      if (list.length < RUNS_PAGE)
        break
    }

    return { runs: runs.slice(0, limit), total: Math.max(total, runs.length) }
  }

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

// Every run of a commit, paged since forges cap a page.
export async function runsOn(sha: string, repo?: string): Promise<Run[]> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const runs: Run[] = []

    for (let page = 1; ; page++) {
      const list = await repoApi<GitLabPipelineRaw[]>(`pipelines?sha=${encodeURIComponent(sha)}&per_page=${GITLAB_PAGE}&page=${page}`, repo)

      runs.push(...list.map(fromGitLabPipeline))

      if (list.length < GITLAB_PAGE)
        return runs
    }
  }

  if (provider === 'github') {
    const runs: Run[] = []

    for (let page = 1; ; page++) {
      const list = ((await repoApi<{ workflow_runs?: GitHubRunRaw[] }>(`actions/runs?head_sha=${encodeURIComponent(sha)}&page=${page}&per_page=${RUNS_PAGE}`, repo)).workflow_runs ?? []).map(fromGitHubRun)

      runs.push(...list)

      if (list.length < RUNS_PAGE)
        return runs
    }
  }

  const runs: Run[] = []

  for (let page = 1; ; page++) {
    const list = (await repoApi<{ workflow_runs: Run[] | null }>(`actions/runs?head_sha=${sha}&page=${page}&limit=${RUNS_PAGE}`, repo)).workflow_runs ?? []

    runs.push(...list)

    if (list.length < RUNS_PAGE)
      return runs
  }
}

export async function runById(id: number, repo?: string): Promise<Run> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return fromGitLabPipeline(await repoApi<GitLabPipelineRaw>(`pipelines/${id}`, repo))

  if (provider === 'github')
    return fromGitHubRun(await repoApi<GitHubRunRaw>(`actions/runs/${id}`, repo))

  return repoApi<Run>(`actions/runs/${id}`, repo)
}

export async function jobsOf(run: number, repo?: string): Promise<Job[]> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const jobs: Job[] = []

    for (let page = 1; ; page++) {
      const batch = await repoApi<GitLabJobRaw[]>(`pipelines/${run}/jobs?per_page=${GITLAB_PAGE}&page=${page}`, repo)

      jobs.push(...batch.map(job => ({
        id: job.id,
        name: job.name,
        stage: job.stage,
        status: normalizeGitLabStatus(job.status),
        allow_failure: job.allow_failure ?? false,
        runs_on: job.tag_list ?? null,
        html_url: job.web_url,
      })))

      if (batch.length < GITLAB_PAGE)
        return jobs
    }
  }

  if (provider === 'github') {
    const data = await repoApi<{ jobs?: GitHubJobRaw[] }>(`actions/runs/${run}/jobs?per_page=100`, repo)

    return (data.jobs ?? []).map(job => ({
      id: job.id,
      name: job.name,
      status: normalizeGitHubStatus(job.status, job.conclusion),
      runs_on: job.labels ?? null,
      html_url: job.html_url,
    }))
  }

  return repoApi<Job[]>(`actions/runs/${run}/jobs`, repo)
}

export async function jobLog(job: number, repo?: string): Promise<string> {
  const { provider } = await resolveForge(repo)

  return repoApiText(provider === 'gitlab' ? `jobs/${job}/trace` : `actions/jobs/${job}/logs`, repo)
}

export async function retryRun(id: number, repo?: string): Promise<Run | undefined> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab')
    return fromGitLabPipeline(await repoWriteOrEmpty<GitLabPipelineRaw>('POST', `pipelines/${id}/retry`, {}, repo) ?? await repoApi<GitLabPipelineRaw>(`pipelines/${id}`, repo))

  if (provider === 'github') {
    await repoSend('POST', `actions/runs/${id}/rerun-failed-jobs`, {}, repo)

    return runById(id, repo)
  }

  await repoSend('POST', `actions/runs/${id}/rerun`, {}, repo)

  return runById(id, repo)
}

export async function retryJob(id: number, repo?: string): Promise<Job | undefined> {
  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    const raw = await repoWriteOrEmpty<GitLabJobRaw>('POST', `jobs/${id}/retry`, {}, repo)

    return raw === undefined ? undefined : { id: raw.id, name: raw.name, stage: raw.stage, status: normalizeGitLabStatus(raw.status), runs_on: raw.tag_list ?? null, html_url: raw.web_url }
  }

  await repoSend('POST', `actions/jobs/${id}/rerun`, {}, repo)

  return undefined
}

export async function playJob(id: number, repo?: string): Promise<Job | undefined> {
  const raw = await repoWriteOrEmpty<GitLabJobRaw>('POST', `jobs/${id}/play`, {}, repo)

  return raw === undefined ? undefined : { id: raw.id, name: raw.name, stage: raw.stage, status: normalizeGitLabStatus(raw.status), runs_on: raw.tag_list ?? null, html_url: raw.web_url }
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

// The newest push run of each workflow, or of the one asked for (for GitLab pipelines, newest pipeline overall).
export function newestPerWorkflow(runs: Run[], workflow?: string): Run[] {
  const newest = new Map<string, Run>()

  for (const run of runs) {
    const isPushLike = run.event === 'push' || run.workflow_id === 'pipeline'

    if (!isPushLike || (workflow !== undefined && run.workflow_id !== workflow))
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

  if (statuses.has('success'))
    return 'success'

  return statuses.has('manual') ? 'manual' : 'skipped'
}

export interface Stall { reason: string, certain: boolean }

// The repo's own runners, which the admin list leaves out; undefined when the login may not read them.
async function repoRunners(repo?: string): Promise<Runner[] | undefined> {
  try {
    return await repoApi<Runner[]>('actions/runners', repo)
  }
  catch {
    return undefined
  }
}

// Why the queued runs are not moving, certain when no online runner carries a job's labels; undefined when it cannot tell.
export async function stallReason(runs: Run[], repo?: string): Promise<Stall | undefined> {
  const queued = runs.filter(run => QUEUED.has(run.status))

  if (queued.length === 0)
    return undefined

  const { provider } = await resolveForge(repo)

  if (provider === 'gitlab') {
    for (const run of queued) {
      const jobs = await jobsOf(run.id, repo)
      const pending = jobs.some(job => job.status === 'running') ? [] : jobs.filter(job => QUEUED.has(job.status))

      if (pending.length > 0)
        return { reason: `pending jobs waiting for a runner: ${pending.map(job => job.name).join(', ')}`, certain: false }
    }

    return undefined
  }

  if (provider === 'github')
    return undefined

  let instance: Runner[]

  try {
    instance = await api<Runner[]>('admin/actions/runners')
  }
  catch {
    return undefined
  }

  const own = await repoRunners(repo)
  const runners = [...instance, ...own ?? []]
  const online = runners.filter(runner => runner.status !== 'offline')

  if (online.length === 0)
    return { reason: runners.length === 0 ? 'no runner is registered' : `every runner is offline (${runners.map(runner => runner.name).join(', ')})`, certain: false }

  for (const run of queued) {
    for (const job of await jobsOf(run.id, repo)) {
      const labels = job.runs_on ?? []

      if (QUEUED.has(job.status) && !online.some(runner => labels.every(label => (runner.labels ?? []).includes(label))))
        return { reason: `job ${job.name} of ${run.workflow_id} runs on ${labels.join(', ')}, which no online runner carries (${online.map(runner => `${runner.name}: ${(runner.labels ?? []).join(', ')}`).join('; ')})`, certain: own !== undefined }
    }
  }

  return online.some(runner => runner.status === 'active') ? undefined : { reason: 'no runner is working on anything: is it up?', certain: false }
}

export interface FailedJob { name: string, run: number, workflow: string, excerpt: string }

// Each failed job of the run, with what its log says went wrong.
export async function failedJobsOf(run: Run, repo?: string): Promise<FailedJob[]> {
  const failed: FailedJob[] = []

  for (const job of await jobsOf(run.id, repo)) {
    if (job.status === 'failure' && job.allow_failure !== true)
      failed.push({ name: job.name, run: run.id, workflow: run.workflow_id, excerpt: excerpt(await jobLog(job.id, repo)) })
  }

  return failed
}

// What each failed job's log says, on stderr: only the title is red on a terminal, ending the colour so the log under it is not a wall of red.
export function failureText(failed: FailedJob[], out: { isTTY?: boolean } = process.stderr): string {
  const problem = role('failed', out)

  return failed.map(job => `${problem(`job ${job.name} of ${job.workflow} failed`)}:\n${job.excerpt}`).join('\n\n')
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
