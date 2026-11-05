import type { ExitRow } from '@kaynooo/cli-kit'
import type { Pipeline } from '../pipelines'
import process from 'node:process'
import { ciHeader, duration, Exit, fail, jsonOption, parse, printJson, role, takesControlCodes, waitForCi } from '@kaynooo/cli-kit'
import { defaultBranch, fetchBranch, git, gitOk, leaveWorktree, resolveCommit } from '../git'
import { ciJson, failedJobsOf, failureText, FINISHED, jobsOf, newest, pipelineLine, pipelinesOn, refreshed, waitingOnRunner } from '../pipelines'

const usage = `gl ci [ref]

Waits for the pipeline covering a commit on the branch, by default origin's tip, and prints what each failed job's trace says.
GitLab runs a push's pipeline on its last commit only, and cancels a redundant one, so a commit without a pipeline of its own is covered by the next commit's.
--json prints {status, runs, failedJobs, url} on stdout, the progress going to stderr; --quiet prints only the announcement, the failures and the result.
An exit 2 says why on the first line of its message: timeout, no runner, no pipeline or not on branch.`

const exits: ExitRow[] = [[0, 'the pipeline passed (or stopped at a manual job, its earlier stages passed)'], [1, 'the pipeline failed'], [2, 'a usage error, or could not check: timeout, no runner, no pipeline, not on branch']]

const options = {
  sha: { type: 'string', short: 's', description: 'the commit to cover, as the [ref] argument does' },
  job: { type: 'string', short: 'j', description: 'a job whose skipping means the pipeline left its work to a newer push' },
  branch: { type: 'string', short: 'b', description: 'branch the commit is on, by default the one origin/HEAD names' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (30m), a bare number in minutes' },
  json: jsonOption('status, runs, failedJobs with their trace excerpts and url'),
  quiet: { type: 'boolean', short: 'q', description: 'no live progress or retry warnings: the announcement, the failures and the result' },
} as const

// How long the wait goes on with no pipeline covering the commit: a push its workflow rules leave out starts none, and a cancelled one's successor may take a poll to appear.
const NO_PIPELINE = 3 * 60_000
// How long jobs may wait for a runner while none of the pipeline's runs; shared runners can take minutes to pick one up.
const STALLED = 10 * 60_000
// How the kit words a wait that ran out of time.
const TIMED_OUT = 'CI has not finished'

export type Coverage = { kind: 'none' | 'passed-over' } | { kind: 'pipeline', pipeline: Pipeline }

// What a commit's newest pipeline says about it: none yet, one to follow, or one over without testing it, so a newer commit's answers for it.
export function judge(pipeline: Pipeline | undefined): Coverage {
  if (pipeline === undefined)
    return { kind: 'none' }

  return pipeline.status === 'canceled' || pipeline.status === 'skipped' ? { kind: 'passed-over' } : { kind: 'pipeline', pipeline }
}

// The wait's own timeout says so first, like the other exit 2 messages do.
export async function waitingOn<T>(wait: () => Promise<T>): Promise<T> {
  try {
    return await wait()
  }
  catch (error) {
    if (error instanceof Exit && error.code === 2 && error.message.startsWith(TIMED_OUT))
      throw new Exit(`timeout: ${error.message}`, error.code, error.hint)

    throw error
  }
}

export async function ci(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { positionals: ['[ref]'], exits })

  const { values, positionals } = parsed

  if (values.sha !== undefined && positionals[0] !== undefined)
    fail('give the commit as [ref] or --sha, not both')

  const branch = values.branch ?? await defaultBranch()
  const giveUp = duration(values.timeout, 'timeout', 30 * 60_000, 'm')
  const given = values.sha ?? positionals[0] ?? `origin/${branch}`
  const sha = await resolveCommit(given)
  const short = sha.slice(0, 7)

  await leaveWorktree()

  // A tag's pipeline is on the tag's ref: a tag named as the argument is followed alone, otherwise the commit's tags are looked at after the branch.
  const commitTags = (await git(['tag', '--points-at', sha])).split('\n').filter(Boolean)
  const refs = commitTags.includes(given) ? [given] : [branch, ...commitTags]

  // Commits whose pipelines are over without testing, which no later poll needs to ask about again.
  const passedOver = new Set<string>()

  // The first of the refs having a pipeline to follow, else passed over when one was, else none.
  async function coverageOf(commit: string, among: string[]): Promise<Coverage> {
    let passed = false

    for (const ref of among) {
      const coverage = judge(newest(await pipelinesOn(commit, undefined, ref)))

      if (coverage.kind === 'pipeline')
        return coverage

      passed ||= coverage.kind === 'passed-over'
    }

    return { kind: passed ? 'passed-over' : 'none' }
  }

  async function covering(): Promise<Pipeline | undefined> {
    await fetchBranch(branch)

    const onBranch = await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`])

    if (!onBranch && commitTags.length === 0)
      fail(`not on branch: ${short} is not on origin/${branch}, push it first`)

    const later = !onBranch || refs[0] !== branch ? [] : (await git(['rev-list', '--reverse', '--first-parent', `${sha}..origin/${branch}`])).split('\n').filter(Boolean)

    for (const commit of [sha, ...later]) {
      if (passedOver.has(commit))
        continue

      const coverage = await coverageOf(commit, commit === sha ? refs : [branch])

      if (coverage.kind === 'pipeline') {
        if (values.job !== undefined && FINISHED.has(coverage.pipeline.status) && (await jobsOf(coverage.pipeline.id)).some(each => each.name === values.job && each.status === 'skipped')) {
          passedOver.add(commit)

          continue
        }

        return coverage.pipeline
      }

      if (coverage.kind === 'passed-over')
        passedOver.add(commit)
    }

    return undefined
  }

  const json = values.json === true
  // On a terminal the pipeline is followed in a live region and ends as one line, in place of the announcement and the result sentence.
  const live = takesControlCodes(process.stderr) && takesControlCodes(process.stdout) && !json && values.quiet !== true
  const pipeline = await waitingOn(async () => waitForCi<Pipeline>({
    tool: 'gl ci',
    short,
    giveUpMs: giveUp,
    noneMs: NO_PIPELINE,
    stalledMs: STALLED,
    quiet: values.quiet === true,
    noneMessage: `no pipeline: none covers ${short} yet, its own was cancelled by a later push or never started, so the next push's will`,
    covering,
    finished: found => FINISHED.has(found.status),
    key: found => String(found.id),
    // The live region links the pipeline, so on a terminal the announcement would only repeat it.
    announce: found => live ? undefined : (json ? console.error : console.log)(`following pipeline ${found.id} on ${found.sha.slice(0, 7)}${found.sha === sha ? '' : `, which covers ${short}`}: ${found.web_url}`),
    links: found => found.web_url,
    settle: async (found) => {
      const latest = await refreshed(found.id)

      return latest !== undefined && FINISHED.has(latest.status) ? latest : undefined
    },
    stall: async (found) => {
      const waiting = waitingOnRunner(await jobsOf(found.id))

      if (waiting.length === 0)
        return undefined

      return { message: `no runner: pipeline ${found.id} on ${short} has waited ${STALLED / 60_000} minutes for a runner: ${waiting.map(job => `${job.name}${job.tag_list.length === 0 ? '' : ` (tags ${job.tag_list.join(', ')})`}`).join('; ')}` }
    },
    // The pipeline followed and its state, on a terminal, under a line for the wait itself.
    lines: (spinner, found, started) => [
      ciHeader(spinner, `CI on ${short}`, started, process.stderr),
      ...found === undefined ? [] : [`  ${pipelineLine(found, process.stderr, found.sha.slice(0, 7))}`],
    ],
  }))

  if (pipeline.status === 'canceled' || pipeline.status === 'skipped')
    fail(`pipeline ${pipeline.id} on ${short} was ${pipeline.status} while GitLab could not be read: ${pipeline.web_url}`)

  if (json) {
    printJson(ciJson(pipeline, pipeline.status === 'failed' ? await failedJobsOf(pipeline) : []))

    return pipeline.status === 'failed' ? 1 : 0
  }

  if (live)
    console.log(pipelineLine(pipeline, process.stdout, pipeline.sha.slice(0, 7)))

  if (pipeline.status !== 'failed') {
    if (live)
      return 0

    console.log(role(pipeline.status === 'manual' ? 'skipped' : 'ok', process.stdout)(pipeline.status === 'manual' ? `CI passed on ${short} up to a manual job: ${pipeline.web_url}` : `CI passed on ${short}`))

    return 0
  }

  console.error(`\n${failureText(await failedJobsOf(pipeline))}\n\npipeline ${pipeline.id} failed${pipeline.sha === sha ? '' : `, testing every commit from ${short} to ${pipeline.sha.slice(0, 7)}`}: ${pipeline.web_url}`)

  return 1
}
