import type { Run } from '../runs'
import process from 'node:process'
import { badge, duration, fail, formatDuration, paint, parse, runHint, waitForCi } from '@kaynooo/cli-kit'
import { defaultBranch, fetchBranch, git, gitOk, leaveWorktree, resolveCommit, tagsAt } from '../git'
import { failureReport, FINISHED, jobsOf, newestPerWorkflow, overall, refreshed, runsOn, stallReason } from '../runs'

const usage = `ft ci [ref]

Waits for the push runs covering a commit on the branch, by default origin's tip, and prints what each failed job's log says.
A push's run tests every commit since the previous push, so a commit whose own run was cancelled, or whose --job was skipped, is covered by the next commit's runs.
Exits 0 when they pass, 1 when one fails, 2 on a timeout, a stalled queue or a commit not on the branch.`

const options = {
  branch: { type: 'string', short: 'b', description: 'branch the commit is on, by default the one origin/HEAD names' },
  workflow: { type: 'string', short: 'w', description: 'only this workflow file, e.g. test.yml; by default every workflow a push starts' },
  job: { type: 'string', short: 'j', description: 'a job whose skipping means the run left its work to a newer push' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (30m), a bare number in minutes' },
} as const

// How long the wait goes on with no run covering the commit: a push touching only ignored paths starts none, and a cancelled run's successor may take a poll to appear.
const NO_RUN = 3 * 60_000
// How long queued runs may sit while no runner works before the wait is given up.
const STALLED = 3 * 60_000
// How many commits of a long gap are asked for their runs on one poll.
const MAX_LOOKUPS = 20

export type Coverage = { kind: 'none' | 'passed-over' } | { kind: 'runs', runs: Run[] }

// What a commit's own runs say about it: still running, done, or over without testing it, so a newer commit's runs answer for it.
export function judge(runs: Run[], jobSkipped: boolean, tagged: boolean): Coverage {
  if (runs.length === 0)
    return { kind: 'none' }

  if (runs.some(run => !FINISHED.has(run.status)))
    return { kind: 'runs', runs }

  if (runs.some(run => run.status === 'cancelled'))
    return { kind: 'passed-over' }

  if (!jobSkipped)
    return { kind: 'runs', runs }

  // A release commit skips its tests for its tag's publish workflow, which runs them on the same tree.
  return tagged ? { kind: 'runs', runs: runs.map(run => ({ ...run, status: 'skipped' })) } : { kind: 'passed-over' }
}

// The commits whose runs are worth asking for on one poll: those not yet known to be passed over, the oldest first and at most `max`, so a long gap costs a bounded number of calls.
export function commitsToAsk(commits: string[], passedOver: Set<string>, max = MAX_LOOKUPS): string[] {
  return commits.filter(commit => !passedOver.has(commit)).slice(0, max)
}

// The runs as a failed poll leaves them once they are all over and none was cancelled; a cancelled one leaves its commit to a newer push's runs, so the wait goes on.
export function settled(latest: Run[] | undefined): Run[] | undefined {
  return latest !== undefined && latest.every(run => FINISHED.has(run.status)) && judge(latest, false, false).kind === 'runs' ? latest : undefined
}

export async function ci(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const branch = values.branch ?? await defaultBranch()
  const giveUp = duration(values.timeout, 'timeout', 30 * 60_000, 'm')
  const sha = await resolveCommit(positionals[0] ?? `origin/${branch}`)
  const short = sha.slice(0, 7)

  await leaveWorktree()

  // Commits whose runs are over without testing, which no later poll needs to ask about again.
  const passedOver = new Set<string>()

  async function coverageOf(commit: string): Promise<Coverage> {
    if (passedOver.has(commit))
      return { kind: 'passed-over' }

    const runs = newestPerWorkflow(await runsOn(commit), values.workflow)
    let jobSkipped = false

    if (values.job !== undefined && runs.every(run => FINISHED.has(run.status))) {
      for (const run of runs)
        jobSkipped ||= (await jobsOf(run.id)).some(job => job.name === values.job && job.status === 'skipped')
    }

    const coverage = judge(runs, jobSkipped, jobSkipped && (await tagsAt(commit)).length > 0)

    if (coverage.kind === 'passed-over')
      passedOver.add(commit)

    return coverage
  }

  async function covering(): Promise<Run[] | undefined> {
    await fetchBranch(branch)

    if (!await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`]))
      fail(`${short} is not on origin/${branch}`, 2, runHint(`git push origin ${branch}`))

    const later = (await git(['rev-list', '--reverse', '--first-parent', `${sha}..origin/${branch}`])).split('\n').filter(Boolean)

    for (const commit of commitsToAsk([sha, ...later], passedOver)) {
      const coverage = await coverageOf(commit)

      if (coverage.kind === 'runs')
        return coverage.runs
    }

    return undefined
  }

  const { dim } = paint(process.stderr)
  const runs = await waitForCi<Run[]>({
    tool: 'ft ci',
    short,
    giveUpMs: giveUp,
    noneMs: NO_RUN,
    stalledMs: STALLED,
    noneMessage: `no run covers ${short} yet: its own was cancelled by a later push or never started, so the next push's will`,
    covering,
    finished: found => found.every(run => FINISHED.has(run.status)),
    key: found => found.map(run => run.id).join(','),
    announce: (found) => {
      for (const run of found)
        console.log(`following ${run.workflow_id} run ${run.id} on ${run.commit_sha.slice(0, 7)}${run.commit_sha === sha ? '' : `, which covers ${short}`}: ${run.html_url}`)
    },
    links: found => found.map(run => run.html_url).join(' '),
    settle: async found => settled(await refreshed(found)),
    stall: async (found) => {
      const stall = await stallReason(found)

      return stall === undefined ? undefined : { message: `runs queued on ${short} are not moving: ${stall.reason}`, certain: stall.certain }
    },
    // The runs followed and their state, on a terminal, under a line for the wait itself.
    lines: (spinner, found, started) => [
      `${spinner} CI on ${short} ${dim(formatDuration(Date.now() - started))}`,
      ...(found ?? []).map(run => `  ${badge(run.status, process.stderr)} ${run.workflow_id} ${dim(`run ${run.id}`)}`),
    ],
  })

  const status = overall(runs)

  if (status !== 'failure') {
    console.log(`CI ${status === 'success' ? 'passed' : 'skipped its tests, a release tag\'s workflow testing them'} on ${short}`)

    return 0
  }

  for (const run of runs) {
    if (run.status === 'failure')
      console.error(`\n${await failureReport(run)}\n\nrun ${run.id} failed${run.commit_sha === sha ? '' : `, testing every commit from ${short} to ${run.commit_sha.slice(0, 7)}`}: ${run.html_url}`)
  }

  return 1
}
