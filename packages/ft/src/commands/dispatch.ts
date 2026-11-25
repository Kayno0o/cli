import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, duration, fail, jsonOption, parse, printJson, writeErr } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { ciJson, recentRuns, runById } from '../runs'
import { repoDefaultBranch, repoWriteOrEmpty, resolveForge } from '../tea'
import { followRuns } from './watch'

const usage = `fg dispatch [<workflow>] [--ref <branch>] [--input key=value]...

Starts a run of a workflow that declares \`on: workflow_dispatch\` (Forgejo/GitHub), or creates a new GitLab pipeline (with \`--input key=value\` as CI variables), on the ref (the default branch's tip unless given).
--wait then follows it to its end as \`fg watch\` does.`
const EXITS: ExitRow[] = [[0, 'the run started, and with --wait it passed'], [1, 'the forge refused it, or with --wait the run failed or was cancelled'], [2, 'a usage error, or with --wait a timeout or a stalled queue']]

const options = {
  ref: { type: 'string', description: 'the branch, tag or commit sha to run, by default the repository\'s default branch' },
  input: { type: 'string', short: 'i', multiple: true, description: 'an input (or GitLab CI variable), key=value, repeatable' },
  wait: { type: 'boolean', short: 'w', description: 'follow the run to its end, exit 1 when it fails' },
  timeout: { type: 'string', short: 't', description: 'how long --wait waits before giving up (30m), a bare number in minutes' },
  quiet: { type: 'boolean', short: 'q', description: 'with --wait, print only the failures and the run\'s final status' },
  json: jsonOption('{id, number, workflow, ref, url}; with --wait, fg watch --json\'s status, runs and failedJobs'),
  ...repoOption,
} as const

const WORKFLOW_FILE = /\.ya?ml$/

interface Dispatched { id: number, run_number?: number, iid?: number }

function parseInputs(given: string[]): Record<string, string> {
  const inputs: Record<string, string> = {}

  for (const each of given) {
    const at = each.indexOf('=')

    if (at <= 0)
      badUsage(`--input takes key=value, not '${each}'`)

    inputs[each.slice(0, at)] = each.slice(at + 1)
  }

  return inputs
}

export async function dispatch(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, {
    positionals: ['[workflow]'],
    exits: EXITS,
    replaces: 'tea/gh/glab api -X POST on a workflow dispatch or pipeline trigger',
    examples: [['fg dispatch apps.yml', 'on the default branch'], ['fg dispatch deploy.yml --ref v1.2.0 -i target=prod --wait', 'a tag, an input, and wait for it']],
  })

  if (values.wait !== true && (values.timeout !== undefined || values.quiet === true))
    badUsage('--timeout and --quiet go with --wait')

  const inputs = parseInputs(values.input ?? [])
  const timeout = duration(values.timeout, 'timeout', 30 * 60_000, 'm')
  const workflow = positionals[0]

  if (workflow !== undefined && !WORKFLOW_FILE.test(workflow))
    badUsage(`<workflow> is a file name under .forgejo/workflows or .github/workflows, such as test.yml, not '${workflow}'`)

  const { provider } = await resolveForge(values.repo)

  if (provider !== 'gitlab' && workflow === undefined)
    badUsage(`a workflow file is needed\n\n${usage}`)

  const ref = values.ref ?? await repoDefaultBranch(values.repo)
  const json = values.json === true
  const wait = values.wait === true
  const say = json ? writeErr : console.log

  let started: Dispatched | undefined

  if (provider === 'gitlab') {
    const variables = Object.entries(inputs).map(([key, value]) => ({ key, value }))

    started = await repoWriteOrEmpty<Dispatched>('POST', 'pipeline', { ref, ...variables.length === 0 ? {} : { variables } }, values.repo)
  }
  else {
    const before = provider === 'github' ? (await recentRuns(1, values.repo, workflow))[0]?.id ?? 0 : 0
    const fields = {
      ref,
      ...Object.keys(inputs).length === 0 ? {} : { inputs },
      ...provider === 'forgejo' ? { return_run_info: true } : {},
    }

    started = await repoWriteOrEmpty<Dispatched>('POST', `actions/workflows/${encodeURIComponent(workflow!)}/dispatches`, fields, values.repo)

    // GitHub's workflow_dispatch returns 204; try locating the newly queued run briefly when requested.
    if (started === undefined && provider === 'github') {
      const recent = await recentRuns(5, values.repo, workflow)
      const newer = recent.find(each => each.id > before)

      if (newer !== undefined)
        started = { id: newer.id, run_number: newer.index_in_repo }
    }
  }

  const label = workflow ?? 'pipeline'

  if (started === undefined) {
    const said = `${label} started on ${ref}, but the forge did not say which run`

    if (wait || json)
      fail(`${said}, so it cannot be ${wait ? 'followed' : 'printed'}`, 1, `fg runs${workflow === undefined ? '' : ` -w ${workflow}`} lists it`)

    writeErr(`${said}: fg runs${workflow === undefined ? '' : ` -w ${workflow}`} lists it`)

    return 0
  }

  const run = await runById(started.id, values.repo)

  if (json && !wait)
    printJson({ id: run.id, number: started.run_number ?? started.iid ?? run.index_in_repo, workflow: label, ref, url: run.html_url })
  else
    say(`started ${label} run ${run.id} on ${ref}: ${run.html_url}`)

  if (!wait)
    return 0

  const followed = await followRuns(runs => runs.filter(each => each.id === run.id), timeout, values.repo, undefined, json ? process.stderr : process.stdout, { json, quiet: values.quiet === true })

  if (json)
    printJson(ciJson(followed.runs, followed.failedJobs))

  return followed.code
}
