import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badUsage, duration, fail, jsonOption, parse, printJson } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { ciJson, runById } from '../runs'
import { api, repoWriteOrEmpty } from '../tea'
import { followRuns } from './watch'

const usage = `ft dispatch <workflow> [--ref <branch>] [--input key=value]...

Starts a run of a workflow that declares \`on: workflow_dispatch\`, on the ref (the default branch's tip unless given), and prints the run's id and link.
--wait then follows it to its end as \`ft watch\` does.`
const EXITS: ExitRow[] = [[0, 'the run started, and with --wait it passed'], [1, 'Forgejo refused it, or with --wait the run failed or was cancelled'], [2, 'a usage error, or with --wait a timeout or a stalled queue']]

const options = {
  ref: { type: 'string', description: 'the branch, tag or commit sha to run, by default the repository\'s default branch' },
  input: { type: 'string', short: 'i', multiple: true, description: 'an input the workflow declares, key=value, repeatable' },
  wait: { type: 'boolean', short: 'w', description: 'follow the run to its end, exit 1 when it fails' },
  timeout: { type: 'string', short: 't', description: 'how long --wait waits before giving up (30m), a bare number in minutes' },
  quiet: { type: 'boolean', short: 'q', description: 'with --wait, print only the failures and the run\'s final status' },
  json: jsonOption('{id, number, workflow, ref, url}; with --wait, ft watch --json\'s status, runs and failedJobs'),
  ...repoOption,
} as const

const WORKFLOW_FILE = /\.ya?ml$/

interface Dispatched { id: number, run_number: number }

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
    positionals: ['<workflow>'],
    exits: EXITS,
    replaces: 'tea api -X POST on a workflow\'s dispatches, then finding the run it started',
    examples: [['ft dispatch apps.yml', 'on the default branch'], ['ft dispatch deploy.yml --ref v1.2.0 -i target=prod --wait', 'a tag, an input, and wait for it']],
  })
  const workflow = positionals[0] ?? badUsage(`a workflow file is needed\n\n${usage}`)

  if (!WORKFLOW_FILE.test(workflow))
    badUsage(`<workflow> is a file name under .forgejo/workflows, such as test.yml, not '${workflow}'`)

  if (values.wait !== true && (values.timeout !== undefined || values.quiet === true))
    badUsage('--timeout and --quiet go with --wait')

  const inputs = parseInputs(values.input ?? [])
  const timeout = duration(values.timeout, 'timeout', 30 * 60_000, 'm')
  const ref = values.ref ?? (await api<{ default_branch: string }>('repos/{owner}/{repo}', values.repo)).default_branch
  const json = values.json === true
  const wait = values.wait === true
  const say = json ? console.error : console.log
  const fields = { ref, ...Object.keys(inputs).length === 0 ? {} : { inputs }, return_run_info: true }
  const started = await repoWriteOrEmpty<Dispatched>('POST', `actions/workflows/${encodeURIComponent(workflow)}/dispatches`, fields, values.repo)

  // A Forgejo whose API predates return_run_info starts the run without saying which, so there is no run to follow or print.
  if (started === undefined) {
    const said = `${workflow} started on ${ref}, but Forgejo did not say which run`

    if (wait || json)
      fail(`${said}, so it cannot be ${wait ? 'followed' : 'printed'}`, 1, `ft runs -w ${workflow} lists it`)

    console.error(`${said}: ft runs -w ${workflow} lists it`)

    return 0
  }

  const run = await runById(started.id, values.repo)

  if (json && !wait)
    printJson({ id: run.id, number: started.run_number, workflow, ref, url: run.html_url })
  else
    say(`started ${workflow} run ${run.id} on ${ref}: ${run.html_url}`)

  if (!wait)
    return 0

  const followed = await followRuns(runs => runs.filter(each => each.id === run.id), timeout, values.repo, undefined, json ? process.stderr : process.stdout, { json, quiet: values.quiet === true })

  if (json)
    printJson(ciJson(followed.runs, followed.failedJobs))

  return followed.code
}
