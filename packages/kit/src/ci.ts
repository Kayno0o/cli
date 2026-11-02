import { Exit, fail } from './args'
import { formatDuration } from './format'
import { liveRegion } from './progress'
import { cwdGone, isPermanentFailure } from './tool'

export interface CiStall {
  // The message the wait fails with.
  message: string
  // Fails at once instead of after `stalledMs`.
  certain?: boolean
}

export interface CiWait<T> {
  // The command's name, as its warnings print it (`ft ci`).
  tool: string
  // The abbreviated sha the wait is for.
  short: string
  giveUpMs: number
  // How long the wait goes on with nothing covering the commit.
  noneMs: number
  // How long queued work may sit while nothing moves.
  stalledMs: number
  pollMs?: number
  // The message the wait fails with once nothing covered the commit for `noneMs`.
  noneMessage: string
  // What covers the commit now, or undefined; a refusal such as a commit not on the branch is thrown as an Exit.
  covering: () => Promise<T | undefined>
  finished: (found: T) => boolean
  // Identifies what is followed, so `announce` runs again when it changes.
  key: (found: T) => string
  announce: (found: T) => void
  // The links to what is followed, for the messages of a wait that ends unfinished.
  links: (found: T) => string
  // What a covering that failed leaves of the followed value once it can be read as over, or undefined to go on polling.
  settle: (found: T) => Promise<T | undefined>
  // Why the unfinished work is not moving, or undefined while it moves.
  stall?: (found: T) => Promise<CiStall | undefined>
  // The lines of a live region under the wait, on a terminal.
  lines?: (spinner: string, found: T | undefined, startedAt: number) => string[]
}

const POLL = 15_000

// Waits until what covers a commit has finished, polling `covering`: a poll failing for a network reason is retried, one failing for good (a missing binary, a 401, 403 or 404) or a refusal ends the wait.
export async function waitForCi<T>(wait: CiWait<T>): Promise<T> {
  const { tool, short, giveUpMs, noneMs, stalledMs, pollMs = POLL } = wait
  const started = Date.now()
  let seen = started
  let moving = started
  let followed = ''
  let found: T | undefined
  const region = wait.lines === undefined ? undefined : liveRegion(spinner => wait.lines?.(spinner, found, started) ?? [])
  const suffix = () => found === undefined ? '' : `: ${wait.links(found)}`

  // A failure to read the stall is retried on the next poll, and leaves the stall unknown.
  async function stallOf(current: T): Promise<CiStall | undefined | 'unknown'> {
    try {
      return await wait.stall?.(current)
    }
    catch (error) {
      if (error instanceof Exit || isPermanentFailure(error))
        throw error

      console.warn(`${tool}: ${error instanceof Error ? error.message : String(error)}, polling again`)

      return 'unknown'
    }
  }

  try {
    for (;;) {
      if (Date.now() - started > giveUpMs)
        fail(`CI has not finished on ${short} in ${formatDuration(giveUpMs)}${suffix()}`)

      // The forge or origin missing one poll leaves the wait to the next, unless what is followed is over by then.
      try {
        found = await wait.covering()
      }
      catch (error) {
        if (error instanceof Exit)
          throw error

        if (cwdGone())
          fail(`the working directory was removed while waiting for CI on ${short}${suffix()}`)

        if (isPermanentFailure(error))
          fail(error instanceof Error ? error.message : String(error))

        console.warn(`${tool}: ${error instanceof Error ? error.message : String(error)}, polling again`)

        const latest = found === undefined ? undefined : await wait.settle(found)

        if (latest !== undefined)
          return latest

        await Bun.sleep(pollMs)

        continue
      }

      if (found !== undefined) {
        seen = Date.now()

        const key = wait.key(found)

        if (key !== followed) {
          followed = key
          moving = Date.now()
          wait.announce(found)
        }

        if (wait.finished(found))
          return found

        const stall = await stallOf(found)

        if (stall === undefined)
          moving = Date.now()
        else if (stall !== 'unknown' && (stall.certain === true || Date.now() - moving > stalledMs))
          fail(stall.message)
      }
      else if (Date.now() - seen > noneMs) {
        fail(wait.noneMessage)
      }

      await Bun.sleep(pollMs)
    }
  }
  finally {
    region?.stop()
  }
}
