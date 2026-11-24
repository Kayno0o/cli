import type { Provider } from '../src/provider'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'

export interface FakeIssue { number: number, title: string, body: string, state: string, labels?: { name: string }[], milestone?: { id: number, title: string } | null | undefined }
export interface FakeMilestone { id: number, title: string, state: string, description?: string, due_on?: string | null }
export interface FakePull { number: number, title: string, body?: string, state: 'open' | 'closed' | 'merged', draft?: boolean, author?: string, head: string, base: string, diff?: string, comments?: string[] }
export interface FakeFailure { match: string, message: string, times?: number, exit?: number }
export interface FakeBarrier { match: string, method?: string, parties: number }
export interface FakeState {
  issues: FakeIssue[]
  milestones?: FakeMilestone[]
  pulls?: FakePull[]
  comments?: Record<number, string[]>
  runs?: Record<string, unknown>[]
  runners?: Record<string, unknown>[]
  repoRunners?: Record<string, unknown>[]
  jobs?: Record<number, unknown[]>
  logs?: Record<number, string>
  calls?: string[][]
  labels?: string[]
  seen?: { token?: string, host?: string }[]
  clobber?: Record<number, string>
  beforeComment?: Record<number, string[]>
  afterComment?: Record<number, string[]>
  failures?: FakeFailure[]
  barrier?: FakeBarrier
  workflows?: string[]
  defaultBranch?: string
  dispatchStatus?: string
  noRunInfo?: boolean
}

const LEADING_SLASHES = /^\/+/
const REPO_PREFIX = /^repos\/[^/]+\/[^/]+\//
const PROJECT_PREFIX = /^projects\/[^/]+\//
const REPO_META = /^(?:repos\/[^/]+\/[^/]+|projects\/[^/]+)$/
const GL_PIPELINE = /^pipelines\/(\d+)$/
const GL_PIPELINE_RETRY = /^pipelines\/(\d+)\/retry$/
const GL_PIPELINE_JOBS = /^pipelines\/(\d+)\/jobs$/
const GL_JOB_TRACE = /^jobs\/(\d+)\/trace$/
const GL_JOB_ACTION = /^jobs\/(\d+)\/(retry|play)$/
const GL_MR = /^merge_requests\/(\d+)(?:\/(notes|changes|merge))?$/
const GL_ISSUE = /^issues\/(\d+)(?:\/notes)?$/
const PR_DIFF = /^pulls\/(\d+)\.diff$/
const PR_MERGE = /^pulls\/(\d+)\/merge$/
const PR_ONE = /^pulls\/(\d+)$/
const WF_DISPATCH = /^actions\/workflows\/([^/]+)\/dispatches$/
const RERUN_RUN = /^actions\/runs\/\d+\/rerun(?:-failed-jobs)?$/
const RERUN_JOB = /^actions\/jobs\/\d+\/rerun$/
const RUN_JOBS = /^actions\/runs\/(\d+)\/jobs$/
const JOB_LOGS = /^actions\/jobs\/(\d+)\/logs$/
const RUN_ONE = /^actions\/runs\/(\d+)$/
const WF_RUNS = /^actions\/workflows\/([^/]+)\/runs$/
const MILESTONE_ONE = /^milestones\/(\d+)$/
const ISSUE_LABELS = /^issues\/(\d+)\/labels(?:\/([^/]+))?$/
const DIGITS = /^\d+$/
const ISSUE_ONE = /^issues\/(\d+)(\/comments)?$/

function paged<T>(list: T[], query: URLSearchParams): T[] {
  const size = Math.min(Number(query.get('limit') ?? query.get('per_page') ?? 30), 50)
  const from = (Number(query.get('page') ?? 1) - 1) * size

  return list.slice(from, from + size)
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined)
    Reflect.deleteProperty(process.env, name)
  else
    process.env[name] = value
}

export async function refusal(pending: Promise<unknown>): Promise<string> {
  try {
    await pending

    return ''
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function hintOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending

    return ''
  }
  catch (error) {
    return error instanceof Exit ? error.hint ?? '' : ''
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

// Runs the callback against an in-process HTTP mock server for Forgejo, GitHub, or GitLab.
// Persists state to FAKE_TEA_STATE so external git hooks (e.g. post-commit in release tests) can push new runs into it.
export async function withFakeForge(provider: Provider, initial: FakeState, run: (ctx: { url: string, state: FakeState }) => Promise<unknown>): Promise<FakeState> {
  const dir = await mkdtemp(join(tmpdir(), 'fg-fake-'))
  const stateFile = join(dir, 'state.json')
  const seed: FakeState = { ...structuredClone(initial), calls: initial.calls ?? [], pulls: initial.pulls ?? [] }

  writeFileSync(stateFile, JSON.stringify(seed))

  let barrierCount = 0
  const barrierWaiters: (() => void)[] = []

  const readState = (): FakeState => JSON.parse(readFileSync(stateFile, 'utf8')) as FakeState
  const saveState = (next: FakeState): void => writeFileSync(stateFile, JSON.stringify(next))

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const method = req.method
      const rawBody = method === 'GET' || method === 'HEAD' ? '' : await req.text()
      const fields = rawBody === '' ? {} as Record<string, unknown> : JSON.parse(rawBody) as Record<string, unknown>
      const trimmedPath = url.pathname.replace(LEADING_SLASHES, '')
      const pathWithQuery = `${trimmedPath}${url.search}`
      const relPath = pathWithQuery.replace(REPO_PREFIX, '').replace(PROJECT_PREFIX, '')
      const qIndex = relPath.indexOf('?')
      const purePath = qIndex === -1 ? relPath : relPath.slice(0, qIndex)
      const query = url.searchParams

      // Optional barrier before reading state so concurrent callers meet at the same step.
      const peek = readState()

      if (peek.barrier !== undefined && relPath.includes(peek.barrier.match) && (peek.barrier.method === undefined || peek.barrier.method === method)) {
        barrierCount++

        if (barrierCount >= peek.barrier.parties) {
          for (const wake of barrierWaiters.splice(0))
            wake()
        }
        else {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5000)

            barrierWaiters.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        }
      }

      const state = readState()

      state.calls ??= []
      state.pulls ??= []
      state.calls.push(rawBody === '' ? [method, relPath] : [method, relPath, rawBody])

      const issue = (num: number) => state.issues.find(each => each.number === num)
      const labelName = (id: number) => (state.labels ?? [])[id - 1]
      const milestoneView = (found: FakeMilestone) => ({
        description: '',
        due_on: null,
        ...found,
        open_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'open').length,
        closed_issues: state.issues.filter(each => each.milestone?.id === found.id && each.state === 'closed').length,
      })
      const issueView = (found: FakeIssue) => ({
        labels: [],
        comments: state.comments?.[found.number]?.length ?? 0,
        html_url: `https://forge/issues/${found.number}`,
        ...found,
      })

      const respond = (res: Response): Response => {
        saveState(state)

        return res
      }

      // Scripted failure injection.
      const failing = (state.failures ?? []).find(each => `${method} ${relPath} ${rawBody}`.includes(each.match) && each.times !== 0)

      if (failing !== undefined) {
        if (failing.times !== undefined)
          failing.times -= 1

        return respond(json({ message: failing.message }, 500))
      }

      if (purePath === 'user')
        return respond(json(provider === 'gitlab' ? { username: 'kaynooo' } : { login: 'kaynooo' }))

      if (REPO_META.test(trimmedPath))
        return respond(json({ default_branch: state.defaultBranch ?? 'main' }))

      // GitLab endpoints.
      if (provider === 'gitlab') {
        if (purePath === 'pipelines' && method === 'GET') {
          const sha = query.get('sha')
          const list = (state.runs ?? []).filter(each => sha === null || each.sha === sha)

          return respond(json(paged(list, query)))
        }

        if (purePath === 'pipeline' && method === 'POST') {
          const id = Math.max(0, ...(state.runs ?? []).map(each => Number(each.id ?? 0))) + 1
          const created = { id, iid: id, sha: 'abc', ref: fields.ref, status: state.dispatchStatus ?? 'pending', source: 'api', web_url: `https://gitlab/pipelines/${id}`, created_at: '2026-10-23T10:00:00Z' }

          state.runs = [created, ...(state.runs ?? [])]

          return respond(json(created, 201))
        }

        const glPipeline = GL_PIPELINE.exec(purePath)

        if (glPipeline !== null) {
          const found = state.runs?.find(each => each.id === Number(glPipeline[1]))

          return respond(found === undefined ? json({ message: 'not found' }, 404) : json(found))
        }

        const glPipelineRetry = GL_PIPELINE_RETRY.exec(purePath)

        if (glPipelineRetry !== null && method === 'POST') {
          const found = state.runs?.find(each => each.id === Number(glPipelineRetry[1]))

          if (found === undefined)
            return respond(json({ message: 'not found' }, 404))

          found.status = 'running'

          return respond(json(found))
        }

        const glPipelineJobs = GL_PIPELINE_JOBS.exec(purePath)

        if (glPipelineJobs !== null)
          return respond(json(state.jobs?.[Number(glPipelineJobs[1])] ?? []))

        const glJobTrace = GL_JOB_TRACE.exec(purePath)

        if (glJobTrace !== null)
          return respond(new Response(state.logs?.[Number(glJobTrace[1])] ?? '', { status: 200 }))

        const glJobAction = GL_JOB_ACTION.exec(purePath)

        if (glJobAction !== null && method === 'POST') {
          const jobId = Number(glJobAction[1])
          const allJobs = Object.values(state.jobs ?? {}).flat() as Record<string, unknown>[]
          const found = allJobs.find(each => each.id === jobId) ?? { id: jobId, name: `job-${jobId}`, stage: 'deploy', status: 'running', web_url: `https://gitlab/jobs/${jobId}` }

          found.status = 'running'

          return respond(json(found))
        }

        if (purePath === 'merge_requests' && method === 'GET') {
          const st = query.get('state')
          const list = state.pulls.filter(pr => st === null || st === 'all' || (st === 'opened' ? pr.state === 'open' : pr.state === st))

          return respond(json(list.map(pr => ({ iid: pr.number, title: pr.title, description: pr.body ?? '', state: pr.state === 'open' ? 'opened' : pr.state, draft: pr.draft ?? false, author: { username: pr.author ?? 'kaynooo' }, source_branch: pr.head, target_branch: pr.base, web_url: `https://gitlab/mr/${pr.number}`, created_at: '2026-10-23T10:00:00Z' }))))
        }

        if (purePath === 'merge_requests' && method === 'POST') {
          const number = Math.max(0, ...state.pulls.map(each => each.number)) + 1
          const created: FakePull = { number, title: String(fields.title), body: String(fields.description ?? ''), state: 'open', draft: String(fields.title).startsWith('Draft:'), author: 'kaynooo', head: String(fields.source_branch), base: String(fields.target_branch) }

          state.pulls.push(created)

          return respond(json({ iid: created.number, title: created.title, description: created.body, state: 'opened', draft: created.draft, author: { username: 'kaynooo' }, source_branch: created.head, target_branch: created.base, web_url: `https://gitlab/mr/${created.number}`, created_at: '2026-10-23T10:00:00Z' }, 201))
        }

        const glMr = GL_MR.exec(purePath)

        if (glMr !== null) {
          const found = state.pulls.find(each => each.number === Number(glMr[1]))

          if (found === undefined)
            return respond(json({ message: 'not found' }, 404))

          if (glMr[2] === 'notes')
            return respond(json((found.comments ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z', author: { username: 'kaynooo' } }))))

          if (glMr[2] === 'changes')
            return respond(json({ changes: [{ old_path: 'a.ts', new_path: 'a.ts', diff: found.diff ?? '@@ -1 +1 @@\n-old\n+new\n' }] }))

          if (glMr[2] === 'merge' && method === 'PUT') {
            found.state = 'merged'

            return respond(json({ iid: found.number, state: 'merged' }))
          }

          return respond(json({ iid: found.number, title: found.title, description: found.body ?? '', state: found.state === 'open' ? 'opened' : found.state, draft: found.draft ?? false, author: { username: found.author ?? 'kaynooo' }, source_branch: found.head, target_branch: found.base, web_url: `https://gitlab/mr/${found.number}`, created_at: '2026-10-23T10:00:00Z' }))
        }

        if (purePath === 'issues' && method === 'GET') {
          const st = query.get('state')
          const list = state.issues.filter(each => st === null || (st === 'opened' ? each.state === 'open' : each.state === st))

          return respond(json(list.map(each => ({ iid: each.number, title: each.title, description: each.body, state: each.state === 'open' ? 'opened' : 'closed', web_url: `https://gitlab/issues/${each.number}`, user_notes_count: state.comments?.[each.number]?.length ?? 0, labels: (each.labels ?? []).map(l => l.name) }))))
        }

        const glIssue = GL_ISSUE.exec(purePath)

        if (glIssue !== null) {
          const found = issue(Number(glIssue[1]))

          if (found === undefined)
            return respond(json({ message: 'not found' }, 404))

          if (purePath.endsWith('/notes')) {
            if (method === 'POST') {
              state.comments = { ...state.comments, [found.number]: [...(state.comments?.[found.number] ?? []), String(fields.body)] }

              return respond(json({ id: 1, body: fields.body }, 201))
            }

            return respond(json((state.comments?.[found.number] ?? []).map(body => ({ body, created_at: '2026-10-23T10:00:00Z', author: { username: 'kaynooo' } }))))
          }

          return respond(json({ iid: found.number, title: found.title, description: found.body, state: found.state === 'open' ? 'opened' : 'closed', web_url: `https://gitlab/issues/${found.number}`, user_notes_count: state.comments?.[found.number]?.length ?? 0, labels: (found.labels ?? []).map(l => l.name) }))
        }
      }

      // Shared Forgejo & GitHub PR endpoints.
      if (purePath === 'pulls' && method === 'GET') {
        const st = query.get('state') ?? 'open'
        const list = state.pulls.filter(pr => st === 'all' || (st === 'open' ? pr.state === 'open' : pr.state !== 'open'))

        return respond(json(list.map(pr => ({ number: pr.number, title: pr.title, body: pr.body ?? '', state: pr.state === 'merged' ? 'closed' : pr.state, merged: pr.state === 'merged', draft: pr.draft ?? false, user: { login: pr.author ?? 'kaynooo' }, head: { ref: pr.head }, base: { ref: pr.base }, html_url: `https://forge/pulls/${pr.number}`, created_at: '2026-10-23T10:00:00Z' }))))
      }

      if (purePath === 'pulls' && method === 'POST') {
        const number = Math.max(0, ...state.pulls.map(each => each.number)) + 1
        const created: FakePull = { number, title: String(fields.title), body: String(fields.body ?? ''), state: 'open', draft: Boolean(fields.draft) || String(fields.title).startsWith('WIP:'), author: 'kaynooo', head: String(fields.head), base: String(fields.base) }

        state.pulls.push(created)

        return respond(json({ number: created.number, title: created.title, body: created.body, state: 'open', draft: created.draft, user: { login: 'kaynooo' }, head: { ref: created.head }, base: { ref: created.base }, html_url: `https://forge/pulls/${created.number}`, created_at: '2026-10-23T10:00:00Z' }, 201))
      }

      const prDiffMatch = PR_DIFF.exec(purePath)

      if (prDiffMatch !== null) {
        const found = state.pulls.find(each => each.number === Number(prDiffMatch[1]))

        return respond(found === undefined ? json({ message: 'not found' }, 404) : new Response(found.diff ?? 'diff --git a/a.ts b/a.ts\n-old\n+new\n', { status: 200 }))
      }

      const prMergeMatch = PR_MERGE.exec(purePath)

      if (prMergeMatch !== null && (method === 'POST' || method === 'PUT')) {
        const found = state.pulls.find(each => each.number === Number(prMergeMatch[1]))

        if (found === undefined)
          return respond(json({ message: 'not found' }, 404))

        found.state = 'merged'

        return respond(json({ merged: true }))
      }

      const prOneMatch = PR_ONE.exec(purePath)

      if (prOneMatch !== null) {
        const found = state.pulls.find(each => each.number === Number(prOneMatch[1]))

        if (found === undefined)
          return respond(json({ message: 'not found' }, 404))

        return respond(json({ number: found.number, title: found.title, body: found.body ?? '', state: found.state === 'merged' ? 'closed' : found.state, merged: found.state === 'merged', draft: found.draft ?? false, user: { login: found.author ?? 'kaynooo' }, head: { ref: found.head }, base: { ref: found.base }, html_url: `https://forge/pulls/${found.number}`, created_at: '2026-10-23T10:00:00Z' }))
      }

      if (purePath.startsWith('git/refs/heads/') && method === 'DELETE')
        return respond(new Response('', { status: 204 }))

      const dispatched = WF_DISPATCH.exec(purePath)

      if (dispatched !== null && method === 'POST') {
        const file = decodeURIComponent(dispatched[1]!)
        const id = Math.max(0, ...(state.runs ?? []).map(each => Number(each.id ?? 0))) + 1

        if (!(state.workflows ?? []).includes(file))
          return respond(json({ message: `workflow "${file}" is not found` }, 404))

        const newRun = provider === 'github'
          ? { id, run_number: id, name: file, path: `.github/workflows/${file}`, event: 'workflow_dispatch', head_branch: fields.ref, head_sha: 'abc', status: 'queued', conclusion: null, html_url: `https://github/runs/${id}`, display_title: file }
          : { id, index_in_repo: id, workflow_id: file, event: 'workflow_dispatch', prettyref: fields.ref, commit_sha: 'abc', status: state.dispatchStatus ?? 'waiting', html_url: `https://forge/runs/${id}`, title: file, inputs: fields.inputs }

        state.runs = [newRun, ...(state.runs ?? [])]

        if (provider === 'forgejo' && fields.return_run_info === true && state.noRunInfo !== true)
          return respond(json({ id, run_number: id, jobs: ['build'] }))

        return respond(new Response('', { status: 204 }))
      }

      if (RERUN_RUN.test(purePath) && method === 'POST')
        return respond(new Response('', { status: 201 }))

      if (RERUN_JOB.test(purePath) && method === 'POST')
        return respond(new Response('', { status: 201 }))

      const runJobs = RUN_JOBS.exec(purePath)

      if (runJobs !== null) {
        const list = state.jobs?.[Number(runJobs[1])] ?? []

        return respond(json(provider === 'github' ? { jobs: list } : list))
      }

      const jobLogs = JOB_LOGS.exec(purePath)

      if (jobLogs !== null) {
        const text = state.logs?.[Number(jobLogs[1])]

        return respond(text === undefined ? json({ message: 'not found' }, 404) : new Response(text, { status: 200 }))
      }

      const runOne = RUN_ONE.exec(purePath)

      if (runOne !== null) {
        const found = state.runs?.find(each => each.id === Number(runOne[1]))

        return respond(found === undefined ? json({ message: 'not found' }, 404) : json(found))
      }

      const wfRuns = WF_RUNS.exec(purePath)

      if (purePath === 'actions/runs' || wfRuns !== null) {
        const wf = wfRuns === null ? query.get('workflow_id') : decodeURIComponent(wfRuns[1]!)
        const sha = query.get('head_sha')
        const matching = (state.runs ?? []).filter((each) => {
          const runSha = String(each.commit_sha ?? each.head_sha ?? '')
          const runWf = String(each.workflow_id ?? (typeof each.path === 'string' ? each.path.split('/').at(-1) : each.name) ?? '')

          return (sha === null || runSha === sha) && (wf === null || runWf === wf)
        })

        return respond(json({ workflow_runs: paged(matching, query), total_count: matching.length }))
      }

      if (purePath === 'admin/actions/runners' || purePath === 'actions/runners') {
        const runners = purePath === 'actions/runners' ? state.repoRunners : state.runners

        return respond(runners === undefined ? json({ message: 'forbidden' }, 403) : json(runners))
      }

      if (purePath === 'labels')
        return respond(json(paged((state.labels ?? []).map((name, at) => ({ id: at + 1, name })), query)))

      if (purePath === 'milestones' && method === 'GET') {
        const st = query.get('state') ?? 'open'
        const list = (state.milestones ?? []).filter(each => st === 'all' || each.state === st).map(milestoneView)

        return respond(json(paged(list, query)))
      }

      if (purePath === 'milestones' && method === 'POST') {
        const created: FakeMilestone = { id: Math.max(0, ...(state.milestones ?? []).map(each => each.id)) + 1, title: String(fields.title), state: 'open', description: String(fields.description ?? ''), due_on: typeof fields.due_on === 'string' ? fields.due_on : null }

        state.milestones = [...(state.milestones ?? []), created]

        return respond(json(milestoneView(created), 201))
      }

      const milestoneOne = MILESTONE_ONE.exec(purePath)

      if (milestoneOne !== null && method === 'PATCH') {
        const target = state.milestones?.find(each => each.id === Number(milestoneOne[1]))

        if (target === undefined)
          return respond(json({ message: 'not found' }, 404))

        Object.assign(target, fields)

        return respond(json(milestoneView(target)))
      }

      const labelsOf = ISSUE_LABELS.exec(purePath)

      if (labelsOf !== null) {
        const target = issue(Number(labelsOf[1]))

        if (target === undefined)
          return respond(json({ message: 'not found' }, 404))

        if (method === 'POST') {
          const incoming = Array.isArray(fields.labels) ? fields.labels : []
          const names = incoming.map(item => typeof item === 'number' ? labelName(item) : String(item)).filter((each): each is string => each !== undefined)

          target.labels = [...(target.labels ?? []), ...names.filter(n => !(target.labels ?? []).some(l => l.name === n)).map(name => ({ name }))]

          return respond(json(target.labels))
        }

        if (method === 'DELETE') {
          const rawId = decodeURIComponent(labelsOf[2] ?? '')
          const removeName = DIGITS.test(rawId) ? labelName(Number(rawId)) : rawId

          target.labels = (target.labels ?? []).filter(each => each.name !== removeName)

          return respond(new Response('', { status: 204 }))
        }
      }

      if (purePath === 'issues' && method === 'GET') {
        const st = query.get('state') ?? 'open'
        const ms = query.get('milestones') ?? query.get('milestone')
        const matching = state.issues.filter(each => each.state === st && (ms === null || each.milestone?.id === Number(ms))).map(issueView)

        return respond(json(query.has('page') || query.has('limit') || query.has('per_page') ? paged(matching, query) : matching))
      }

      if (purePath === 'issues' && method === 'POST') {
        const incomingLabels = Array.isArray(fields.labels) ? fields.labels : []
        const labels = incomingLabels.map(item => typeof item === 'number' ? labelName(item) : String(item)).filter((each): each is string => each !== undefined).map(name => ({ name }))
        const msId = typeof fields.milestone === 'number' ? fields.milestone : undefined
        const ms = msId === undefined ? null : state.milestones?.find(each => each.id === msId) ?? null
        const created: FakeIssue = { number: Math.max(0, ...state.issues.map(each => each.number)) + 1, title: String(fields.title), body: String(fields.body ?? ''), state: 'open', labels, milestone: ms }

        state.issues.push(created)

        return respond(json(issueView(created), 201))
      }

      const one = ISSUE_ONE.exec(purePath)

      if (one !== null) {
        const num = Number(one[1])
        const found = issue(num)

        if (one[2] !== undefined) {
          const pr = state.pulls.find(each => each.number === num)

          if (method === 'POST') {
            const before = state.beforeComment?.[num] ?? []
            const after = state.afterComment?.[num] ?? []

            state.comments = { ...state.comments, [num]: [...(state.comments?.[num] ?? []), ...before, String(fields.body), ...after] }
            delete state.beforeComment?.[num]
            delete state.afterComment?.[num]

            return respond(json({ id: 1, body: fields.body }, 201))
          }

          const list = state.comments?.[num] ?? pr?.comments ?? []

          return respond(json(list.map(body => ({ body, created_at: '2026-10-23T10:00:00Z', user: { login: 'kaynooo' } }))))
        }

        if (found === undefined)
          return respond(json({ message: 'not found' }, 404))

        if (method === 'PATCH') {
          if (typeof fields.title === 'string')
            found.title = fields.title

          if (typeof fields.body === 'string') {
            found.body = fields.body

            if (state.clobber?.[num] !== undefined) {
              found.body = state.clobber[num]!
              delete state.clobber[num]
            }
          }

          if (typeof fields.state === 'string')
            found.state = fields.state

          if (fields.milestone !== undefined)
            found.milestone = fields.milestone === 0 || fields.milestone === null ? null : state.milestones?.find(each => each.id === Number(fields.milestone)) ?? null

          return respond(json(issueView(found)))
        }

        return respond(json(issueView(found)))
      }

      return respond(json({ message: `unhandled ${method} ${purePath}` }, 404))
    },
  })

  const apiUrl = `http://127.0.0.1:${server.port}`
  const saved = {
    api: process.env.FORGE_API_URL,
    provider: process.env.FORGE_PROVIDER,
    token: process.env.FORGE_TOKEN,
    repo: process.env.FORGE_REPO,
    state: process.env.FAKE_TEA_STATE,
  }

  try {
    process.env.FORGE_API_URL = apiUrl
    process.env.FORGE_PROVIDER = provider
    process.env.FORGE_TOKEN = 'fake-token'
    process.env.FORGE_REPO = 'owner/repo'
    process.env.FAKE_TEA_STATE = stateFile
    await run({ url: apiUrl, state: readState() })

    return readState()
  }
  finally {
    await server.stop(true)
    restore('FORGE_API_URL', saved.api)
    restore('FORGE_PROVIDER', saved.provider)
    restore('FORGE_TOKEN', saved.token)
    restore('FORGE_REPO', saved.repo)
    restore('FAKE_TEA_STATE', saved.state)
    await rm(dir, { recursive: true, force: true })
  }
}

export async function withFakeTea(initial: FakeState, run: () => Promise<unknown>): Promise<FakeState> {
  return withFakeForge('forgejo', initial, async () => run())
}
