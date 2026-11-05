import type { FailedJob, Run } from '../runs'
import { ciHeader, duration, Exit, fail, formatDuration, isPermanentFailure, jsonOption, parse, printJson, takesControlCodes, wholeNumber } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { repoOption } from '../args'
import { ciJson, failedJobsOf, failureText, FINISHED, overall, recentRuns, runById, runLine, stallReason } from '../runs'

const usage = `ft watch [--after <id>]

Waits for runs to finish: those newer than run <id>, or else the ones in progress now.
Prints nothing but failures and each run's final status with --quiet, and a JSON result with --json.
Exits 0 when every one passed or was skipped, 1 when one failed or was cancelled, 2 on a timeout or a stalled queue.`

const options = {
  after: { type: 'string', short: 'a', description: 'watch the runs newer than this run id, as `ft runs --json` gives it' },
  timeout: { type: 'string', short: 't', description: 'how long before giving up (15m), a bare number in minutes' },
  json: jsonOption('status, runs, failedJobs with their log excerpts and url; the progress goes to stderr'),
  quiet: { type: 'boolean', short: 'q', description: 'print only the failures and each run\'s final status' },
  ...repoOption,
} as const

// Mutable so a test can poll faster.
export const timing = { poll: 10_000 }
const LIMIT = 20
const STALLED = 3 * 60_000

type Output = NonNullable<Parameters<typeof liveRegion>[1]>

export interface Followed { code: number, runs: Run[], failedJobs: FailedJob[] }

interface Mode {
  // Failures are collected into the result instead of printed.
  json?: boolean
  // Nothing prints while waiting; each run's last status prints once at the end.
  quiet?: boolean
}

// Polls until the picked runs are all finished, a failure printing its jobs' log excerpts. A terminal shows one line per run redrawn in place, then each run's last status; anything else gets a line per status change.
// With `idle`, picking no run for that many milliseconds counts as a pass: a push touching only ignored paths starts none.
export async function watchRuns(pick: (runs: Run[]) => Run[], timeout: number, repo?: string, idle?: number, out: Output = process.stdout): Promise<number> {
  return (await followRuns(pick, timeout, repo, idle, out)).code
}

export async function followRuns(pick: (runs: Run[]) => Run[], timeout: number, repo?: string, idle?: number, out: Output = process.stdout, mode: Mode = {}): Promise<Followed> {
  const { json = false, quiet = false } = mode
  const started = Date.now()
  // The last state of every run seen, in the order they appeared.
  const latest = new Map<number, Run>()
  // When each run was first seen, the wait counted from there until Forgejo says it started.
  const seen = new Map<number, number>()
  const line = (run: Run) => runLine(run, out, seen.get(run.id) ?? Date.now())
  const region = takesControlCodes(out) && !quiet ? liveRegion(spinner => [ciHeader(spinner, 'CI', started, out), ...[...latest.values()].map(run => `  ${line(run)}`)], out) : undefined
  // Every run ever picked, read again by id once newer runs push it out of the page of the newest ones.
  const followed = new Set<number>()
  const failed = new Set<number>()
  const failedJobs: FailedJob[] = []
  let moving = started

  // One look at the runs: the exit code once they are decided, or undefined to poll again.
  async function poll(): Promise<number | undefined> {
    const newest = await recentRuns(LIMIT, repo)
    const gone = await Promise.all([...followed].filter(id => !newest.some(run => run.id === id)).map(async id => runById(id, repo)))
    const runs = [...pick(newest), ...gone]

    for (const run of runs)
      followed.add(run.id)

    for (const run of runs) {
      if (!seen.has(run.id))
        seen.set(run.id, Date.now())

      if (region === undefined && !quiet && latest.get(run.id)?.status !== run.status)
        out.write(`${line(run)}\n`)

      latest.set(run.id, run)
    }

    region?.redraw()

    if (runs.length === 0) {
      if (idle !== undefined && Date.now() - started > idle) {
        if (!json)
          out.write('no run started, so nothing was waited for\n')

        return 0
      }

      return undefined
    }

    // A failure is reported as soon as it happens, but the wait goes on until every run is over, as `ft ci` does.
    for (const run of runs) {
      if (run.status === 'failure' && !failed.has(run.id)) {
        const jobs = await failedJobsOf(run, repo)

        failedJobs.push(...jobs)

        if (!json)
          console.error(`\n${failureText(jobs)}\n\n${run.html_url}`)

        failed.add(run.id)
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

    return undefined
  }

  async function settle(): Promise<number> {
    for (;;) {
      // Sleeping first gives a push's runs time to all appear, so one finishing early is not taken for the lot.
      await Bun.sleep(timing.poll)

      if (Date.now() - started > timeout)
        fail(`the runs did not finish in ${formatDuration(timeout)}`)

      // Every call to the forge sits in the retry: one failing leaves the wait to the next poll, unless it can only fail again.
      try {
        const code = await poll()

        if (code !== undefined)
          return code
      }
      catch (error) {
        if (error instanceof Exit)
          throw error

        const message = error instanceof Error ? error.message : String(error)

        if (isPermanentFailure(error))
          fail(message)

        if (!quiet)
          console.warn(`ft watch: ${message}, polling again`)
      }
    }
  }

  try {
    return { code: await settle(), runs: [...latest.values()], failedJobs }
  }
  finally {
    region?.stop()

    if (region !== undefined || quiet) {
      for (const run of latest.values())
        out.write(`${line(run)}\n`)
    }
  }
}

export async function watch(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values } = parsed
  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')
  const json = values.json === true
  const mode = { json, quiet: values.quiet === true }

  async function follow(pick: (runs: Run[]) => Run[]): Promise<number> {
    const followed = await followRuns(pick, timeout, values.repo, undefined, json ? process.stderr : process.stdout, mode)

    if (json)
      printJson(ciJson(followed.runs, followed.failedJobs))

    return followed.code
  }

  if (values.after !== undefined) {
    const after = wholeNumber(values.after, 'after', 0, 0)

    return follow(runs => runs.filter(run => run.id > after))
  }

  const active = new Set((await recentRuns(LIMIT, values.repo)).filter(run => !FINISHED.has(run.status)).map(run => run.id))

  if (active.size === 0) {
    if (json)
      printJson(ciJson([], []))
    else
      console.log('no run in progress')

    return 0
  }

  return follow(runs => runs.filter(run => active.has(run.id)))
}
