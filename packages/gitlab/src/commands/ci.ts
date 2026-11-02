import type { Pipeline } from '../pipelines'
import { duration, Exit, fail, parse } from '@kaynooo/cli-kit'
import { cwdGone, defaultBranch, fetchBranch, git, gitOk, leaveWorktree, resolveCommit } from '../git'
import { failureReport, FINISHED, jobsOf, newest, pipelinesOn, refreshed, waitingOnRunner } from '../pipelines'

const usage = `gl ci [ref]

Waits for the pipeline covering a commit on the branch, by default origin's tip, and prints what each failed job's trace says.
GitLab runs a push's pipeline on its last commit only, and cancels a redundant one, so a commit without a pipeline of its own is covered by the next commit's.
Exits 0 when it passes, 1 when it fails, 2 on a timeout, jobs no runner picks up or a commit not on the branch.`

const options = {
  branch: { type: 'string', short: 'b', description: 'branch the commit is on, by default the one origin/HEAD names' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (30m), a bare number in minutes' },
} as const

const POLL = 15_000
// How long the wait goes on with no pipeline covering the commit: a push its workflow rules leave out starts none, and a cancelled one's successor may take a poll to appear.
const NO_PIPELINE = 3 * 60_000
// How long jobs may wait for a runner while none of the pipeline's runs; shared runners can take minutes to pick one up.
const STALLED = 10 * 60_000

export type Coverage = { kind: 'none' | 'passed-over' } | { kind: 'pipeline', pipeline: Pipeline }

// What a commit's newest pipeline says about it: none yet, one to follow, or one over without testing it, so a newer commit's answers for it.
export function judge(pipeline: Pipeline | undefined): Coverage {
  if (pipeline === undefined)
    return { kind: 'none' }

  return pipeline.status === 'canceled' || pipeline.status === 'skipped' ? { kind: 'passed-over' } : { kind: 'pipeline', pipeline }
}

export async function ci(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const branch = values.branch ?? await defaultBranch()
  const giveUp = duration(values.timeout, 'timeout', 30 * 60_000, 'm')
  const sha = await resolveCommit(positionals[0] ?? `origin/${branch}`)
  const short = sha.slice(0, 7)

  await leaveWorktree()

  // Commits whose pipelines are over without testing, which no later poll needs to ask about again.
  const passedOver = new Set<string>()

  async function covering(): Promise<Pipeline | undefined> {
    await fetchBranch(branch)

    if (!await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`]))
      fail(`${short} is not on origin/${branch}: push it first`)

    const later = (await git(['rev-list', '--reverse', '--first-parent', `${sha}..origin/${branch}`])).split('\n').filter(Boolean)

    for (const commit of [sha, ...later]) {
      if (passedOver.has(commit))
        continue

      const coverage = judge(newest(await pipelinesOn(commit, undefined, branch)))

      if (coverage.kind === 'pipeline')
        return coverage.pipeline

      if (coverage.kind === 'passed-over')
        passedOver.add(commit)
    }

    return undefined
  }

  const started = Date.now()
  let seen = started
  let moving = started
  let followed = 0
  let pipeline: Pipeline | undefined

  for (;;) {
    if (Date.now() - started > giveUp)
      fail(`CI has not finished on ${short} in ${giveUp / 60_000} minutes${pipeline === undefined ? '' : `: ${pipeline.web_url}`}`)

    // GitLab or origin missing one poll leaves the wait to the next, unless the pipeline followed is over by then.
    try {
      pipeline = await covering()
    }
    catch (error) {
      if (error instanceof Exit)
        throw error

      if (cwdGone())
        fail(`the working directory was removed while waiting for CI on ${short}${pipeline === undefined ? '' : `: ${pipeline.web_url}`}`)

      console.warn(`gl ci: ${error instanceof Error ? error.message : String(error)}, polling again`)

      const latest = pipeline === undefined ? undefined : await refreshed(pipeline.id)

      if (latest !== undefined && FINISHED.has(latest.status)) {
        pipeline = latest

        break
      }

      await Bun.sleep(POLL)

      continue
    }

    if (pipeline !== undefined) {
      seen = Date.now()

      if (pipeline.id !== followed) {
        followed = pipeline.id
        moving = Date.now()
        console.log(`following pipeline ${pipeline.id} on ${pipeline.sha.slice(0, 7)}${pipeline.sha === sha ? '' : `, which covers ${short}`}: ${pipeline.web_url}`)
      }

      if (FINISHED.has(pipeline.status))
        break

      const waiting = waitingOnRunner(await jobsOf(pipeline.id))

      if (waiting.length === 0)
        moving = Date.now()
      else if (Date.now() - moving > STALLED)
        fail(`pipeline ${pipeline.id} on ${short} has waited ${STALLED / 60_000} minutes for a runner: ${waiting.map(job => `${job.name}${job.tag_list.length === 0 ? '' : ` (tags ${job.tag_list.join(', ')})`}`).join('; ')}`)
    }
    else if (Date.now() - seen > NO_PIPELINE) {
      fail(`no pipeline covers ${short} yet: its own was cancelled by a later push or never started, so the next push's will`)
    }

    await Bun.sleep(POLL)
  }

  if (pipeline.status === 'canceled' || pipeline.status === 'skipped')
    fail(`pipeline ${pipeline.id} on ${short} was ${pipeline.status} while GitLab could not be read: ${pipeline.web_url}`)

  if (pipeline.status !== 'failed') {
    console.log(pipeline.status === 'manual' ? `CI passed on ${short} up to a manual job: ${pipeline.web_url}` : `CI passed on ${short}`)

    return 0
  }

  console.error(`\n${await failureReport(pipeline)}\n\npipeline ${pipeline.id} failed${pipeline.sha === sha ? '' : `, testing every commit from ${short} to ${pipeline.sha.slice(0, 7)}`}: ${pipeline.web_url}`)

  return 1
}
