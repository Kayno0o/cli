import type { Run } from '../runs'
import { badge, duration, fail, formatDuration, parse, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { failureReport, FINISHED, overall, recentRuns, runById, stallReason } from '../runs'

const usage = `ft watch [--after <id>]

Waits for runs to finish: those newer than run <id>, or else the ones in progress now.
Exits 0 when every one passed or was skipped, 1 when one failed or was cancelled, 2 on a timeout or a stalled queue.`

const options = {
  after: { type: 'string', short: 'a', description: 'watch the runs newer than this run id, as `ft runs --json` gives it' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (15m), a bare number in minutes' },
  ...repoOption,
} as const

// Mutable so a test can poll faster.
export const timing = { poll: 10_000 }
const LIMIT = 20
const STALLED = 3 * 60_000

// Polls until the picked runs are all finished, printing each status change; a failure prints its jobs' log excerpts.
// With `idle`, picking no run for that many milliseconds counts as a pass: a push touching only ignored paths starts none.
export async function watchRuns(pick: (runs: Run[]) => Run[], timeout: number, repo?: string, idle?: number): Promise<number> {
  const started = Date.now()
  const reported = new Map<number, string>()
  // Every run ever picked, read again by id once newer runs push it out of the page of the newest ones.
  const followed = new Set<number>()
  const failed = new Set<number>()
  let moving = started

  for (;;) {
    // Sleeping first gives a push's runs time to all appear, so one finishing early is not taken for the lot.
    await Bun.sleep(timing.poll)

    if (Date.now() - started > timeout)
      fail(`the runs did not finish in ${formatDuration(timeout)}`)

    let runs: Run[]

    try {
      const newest = await recentRuns(LIMIT, repo)
      const gone = await Promise.all([...followed].filter(id => !newest.some(run => run.id === id)).map(async id => runById(id, repo)))

      runs = [...pick(newest), ...gone]

      for (const run of runs)
        followed.add(run.id)
    }
    catch (error) {
      console.warn(`ft watch: ${error instanceof Error ? error.message : String(error)}, polling again`)

      continue
    }

    for (const run of runs) {
      if (reported.get(run.id) !== run.status)
        console.log(`${run.workflow_id} run ${run.id} on ${run.prettyref}: ${badge(run.status, process.stdout)}`)

      reported.set(run.id, run.status)
    }

    if (runs.length === 0) {
      if (idle !== undefined && Date.now() - started > idle) {
        console.log('no run started, so nothing was waited for')

        return 0
      }

      continue
    }

    // A failure is reported as soon as it happens, but the wait goes on until every run is over, as `ft ci` does.
    for (const run of runs) {
      if (run.status === 'failure' && !failed.has(run.id)) {
        failed.add(run.id)
        console.error(`\n${await failureReport(run, repo)}\n\n${run.html_url}`)
      }
    }

    if (runs.every(run => FINISHED.has(run.status))) {
      const status = overall(runs)

      return status === 'failure' || status === 'cancelled' ? 1 : 0
    }

    const stall = await stallReason(runs, repo)

    if (stall === undefined)
      moving = Date.now()
    else if (stall.certain || Date.now() - moving > STALLED)
      fail(`queued runs are not moving: ${stall.reason}`)
  }
}

export async function watch(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values } = parsed
  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')

  if (values.after !== undefined) {
    const after = wholeNumber(values.after, 'after', 0, 0)

    return watchRuns(runs => runs.filter(run => run.id > after), timeout, values.repo)
  }

  const active = new Set((await recentRuns(LIMIT, values.repo)).filter(run => !FINISHED.has(run.status)).map(run => run.id))

  if (active.size === 0) {
    console.log('no run in progress')

    return 0
  }

  return watchRuns(runs => runs.filter(run => active.has(run.id)), timeout, values.repo)
}
