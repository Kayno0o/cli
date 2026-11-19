import type { RunSettings, ToolRun } from '@kaynooo/cli-kit'
import { exitCodeOf, fail, holdSignals, runHint, runTool } from '@kaynooo/cli-kit'
import { askpass } from '@kaynooo/cli-kit/askpass'
import { fetchBranch, git, gitOk } from '../git'
import { FINISHED, newestPerWorkflow, overall, recentRuns } from '../runs'
import { watchRuns } from './watch'

// How long a push may take before it is given up; tests shorten it.
export const limits = { pushMs: 5 * 60_000 }

const BRANCH_REFSPEC = /^([^:]+):refs\/heads\/(.+)$/

// Origin's push URLs with the forge it fetches from first; with no extra push URL, just origin.
async function pushUrls(): Promise<string[]> {
  const urls = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).split('\n').filter(Boolean)

  if (urls.length < 2)
    return ['origin']

  const forge = await git(['remote', 'get-url', 'origin'])

  return urls.includes(forge) ? [forge, ...urls.filter(url => url !== forge)] : urls
}

// --atomic holds per URL, not across origin's push URLs: a mirror (GitHub) only gets the push once the forge has taken it, and its refusal leaves the release standing.
// The push runs in its own session for its timeout, where ssh has no terminal to ask a passphrase on: askpass asks it on this one.
export async function pushToOrigin(refspecs: string[], onStart: RunSettings['onStart'], atomic = false): Promise<ToolRun> {
  const [forge = 'origin', ...mirrors] = await pushUrls()
  const prompts = askpass()
  const push = async (url: string) => runTool('git push', ['git', 'push', ...(atomic ? ['--atomic'] : []), url, ...refspecs], { timeoutMs: limits.pushMs, onStart, env: prompts.env })

  try {
    const pushed = await push(forge)

    if (pushed.code !== 0 || mirrors.length === 0)
      return pushed

    // A push by URL leaves origin's tracking refs where they were.
    for (const refspec of refspecs) {
      const branch = BRANCH_REFSPEC.exec(refspec)

      if (branch !== null)
        await git(['update-ref', `refs/remotes/origin/${branch[2]}`, `${branch[1]}^{commit}`])
    }

    for (const mirror of mirrors) {
      const mirrored = await push(mirror)

      if (mirrored.code !== 0)
        console.error(`warning: ${mirror} refused the push, so it lags behind origin until a later push lands:\n${mirrored.stderr.trim()}`)
    }

    return pushed
  }
  finally {
    prompts.close()
  }
}
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
export async function testsPass(sha: string, branch: string, timeout: number, json = false): Promise<boolean> {
  const say = json ? console.error : console.log

  if (!await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`])) {
    const held = holdSignals()
    let push

    try {
      push = await pushToOrigin([`${sha}:refs/heads/${branch}`], child => held.forward(child))
    }
    finally {
      held.release()
    }

    if (held.signal !== undefined)
      fail(`interrupted by ${held.signal} while pushing ${sha.slice(0, 7)}, so nothing was bumped`, exitCodeOf(null, held.signal))

    if (push.code !== 0)
      fail(`origin refused the push of ${sha.slice(0, 7)}, so nothing was bumped:\n${push.stderr.trim()}`, 1)

    say(`pushed ${branch} at ${sha.slice(0, 7)}, waiting for its runs before the bump`)
  }
  else if (await alreadyPassed(sha)) {
    return true
  }
  else {
    say(`${branch} at ${sha.slice(0, 7)} is on origin, waiting for its runs before the bump`)
  }

  if (await watchRuns(runs => newestPerWorkflow(runs.filter(run => run.commit_sha === sha)), timeout, undefined, NO_RUN, json ? process.stderr : process.stdout) === 0)
    return true

  await failWhenSuperseded(sha, branch)

  return false
}

// A push landing on the branch while its runs wait has Forgejo cancel them, which is no test failure: the release names that push instead.
async function failWhenSuperseded(sha: string, branch: string): Promise<void> {
  const own = newestPerWorkflow((await recentRuns(RUNS_LOOKED_AT)).filter(run => run.commit_sha === sha))

  if (overall(own) !== 'cancelled' || !await fetchBranch(branch))
    return

  const tip = await git(['log', '-1', '--format=%h %s', '--abbrev=7', `origin/${branch}`])

  if (!tip.startsWith(sha.slice(0, 7)) && await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`]))
    fail(`a later push to origin (${tip}) cancelled the runs on ${sha.slice(0, 7)}, so nothing was bumped or tagged`, 1, runHint(`git pull --ff-only origin ${branch}`, 'bring it in, then run the release again'))
}
