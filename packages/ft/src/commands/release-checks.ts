import { exitCodeOf, fail, holdSignals, runTool } from '@kaynooo/cli-kit'
import { gitOk } from '../git'
import { FINISHED, newestPerWorkflow, overall, recentRuns } from '../runs'
import { watchRuns } from './watch'

// How long a push may take before it is given up; tests shorten it.
export const limits = { pushMs: 5 * 60_000 }
// How long a pushed commit may go without a run before the release goes on: a push touching only ignored paths starts none.
export const NO_RUN = 3 * 60_000
// How many of the newest runs are searched for a commit's own, as `ft watch` does.
const RUNS_LOOKED_AT = 20

// Whether the commit's newest run of each workflow is over and passed, as after the previous release; a forge error answers no, leaving it to the wait.
async function alreadyPassed(sha: string): Promise<boolean> {
  try {
    const own = newestPerWorkflow((await recentRuns(RUNS_LOOKED_AT)).filter(run => run.commit_sha === sha))

    return own.length > 0 && own.every(run => FINISHED.has(run.status)) && ['success', 'skipped'].includes(overall(own))
  }
  catch {
    return false
  }
}

// Pushes the commit a release sits on when origin lacks it and waits for its own runs, so a red run stops the release before a tag exists that would never publish.
// Runs that already passed on a commit origin has are not waited for nor printed again.
export async function testsPass(sha: string, branch: string, timeout: number): Promise<boolean> {
  if (!await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`])) {
    const held = holdSignals()
    let push

    try {
      push = await runTool('git push', ['git', 'push', 'origin', `${sha}:refs/heads/${branch}`], { timeoutMs: limits.pushMs, onStart: child => held.forward(child) })
    }
    finally {
      held.release()
    }

    if (held.signal !== undefined)
      fail(`interrupted by ${held.signal} while pushing ${sha.slice(0, 7)}, so nothing was bumped`, exitCodeOf(null, held.signal))

    if (push.code !== 0)
      fail(`origin refused the push of ${sha.slice(0, 7)}, so nothing was bumped:\n${push.stderr.trim()}`, 1)

    console.log(`pushed ${branch} at ${sha.slice(0, 7)}, waiting for its runs before the bump`)
  }
  else if (await alreadyPassed(sha)) {
    return true
  }
  else {
    console.log(`${branch} at ${sha.slice(0, 7)} is on origin, waiting for its runs before the bump`)
  }

  return await watchRuns(runs => newestPerWorkflow(runs.filter(run => run.commit_sha === sha)), timeout, undefined, NO_RUN) === 0
}
