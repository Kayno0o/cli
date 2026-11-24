import type { ExitRow } from '@kaynooo/cli-kit'
import { fail, jsonOption, parse, printJson, role, runHint, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { jobsOf, playJob, retryJob, retryRun, runJson } from '../runs'

const retryUsage = `fg retry <run id> [-j <job>]

Retries the failed jobs of a run/pipeline, or with -j one job by name or id.
With -j and no run id, the value is a job id.`

const RETRY_EXITS: ExitRow[] = [[0, 'retried'], [1, 'forge refused or cannot be read'], [2, 'a usage error, or a job the run lacks']]

const retryOptions = {
  job: { type: 'string', short: 'j', description: 'retry only this job, by name or id' },
  json: jsonOption('the retried run or job'),
  ...repoOption,
} as const

export async function retry(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, retryUsage, retryOptions, { positionals: ['[run]'], exits: RETRY_EXITS })
  const [given] = positionals

  if (given === undefined && values.job === undefined)
    fail('a run id or a job is needed', 2, runHint('fg runs', 'list recent runs'))

  if (values.job === undefined) {
    const id = wholeNumber(given ?? '', '<run id>', 1)
    const run = await retryRun(id, values.repo)

    if (values.json === true)
      printJson(run === undefined ? { id, retried: true } : runJson(run))
    else
      console.log(`${role('running', process.stdout)(`retrying run ${id}`)}${run === undefined ? '' : `: ${role('path', process.stdout)(run.html_url)}`}`)

    return 0
  }

  let jobId = Number(values.job)

  if (given !== undefined) {
    const runId = wholeNumber(given, '<run id>', 1)
    const jobs = await jobsOf(runId, values.repo)
    const found = jobs.find(each => each.name === values.job || String(each.id) === values.job)

    if (found === undefined)
      fail(`run ${runId} has no job ${values.job}: ${jobs.map(each => each.name).join(', ')}`, 2)

    jobId = found.id
  }
  else if (!Number.isInteger(jobId) || jobId < 1) {
    fail(`without a run id, -j takes a job id, not ${values.job}`, 2, runHint('fg retry <run id> -j <name>', 'retry it by name'))
  }

  const job = await retryJob(jobId, values.repo)

  if (values.json === true)
    printJson(job === undefined ? { id: jobId, retried: true } : { id: job.id, name: job.name, stage: job.stage ?? null, status: job.status, url: job.html_url ?? null })
  else
    console.log(`${role('running', process.stdout)(`retrying job ${job?.name ?? jobId} (${jobId})`)}${job?.html_url === undefined ? '' : `: ${role('path', process.stdout)(job.html_url)}`}`)

  return 0
}

const playUsage = `fg play <job id> | fg play <pipeline id> -j <job>

Starts a manual GitLab job by job id, or by job name inside a pipeline.`

const PLAY_EXITS: ExitRow[] = [[0, 'manual job started'], [1, 'forge refused or cannot be read'], [2, 'a usage error, or a job the pipeline lacks']]

const playOptions = {
  job: { type: 'string', short: 'j', description: 'manual job name or id inside the given pipeline' },
  json: jsonOption('{id, name, stage, status, url}'),
  ...repoOption,
} as const

export async function play(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, playUsage, playOptions, { positionals: ['<id>'], exits: PLAY_EXITS })
  const [given] = positionals

  if (given === undefined)
    fail('a job id or pipeline id with -j <job> is needed', 2, runHint('fg runs', 'list pipelines'))

  let jobId = wholeNumber(given, '<id>', 1)

  if (values.job !== undefined) {
    const jobs = await jobsOf(jobId, values.repo)
    const found = jobs.find(each => each.name === values.job || String(each.id) === values.job)

    if (found === undefined)
      fail(`pipeline ${jobId} has no job ${values.job}: ${jobs.map(each => each.name).join(', ')}`, 2)

    jobId = found.id
  }

  const job = await playJob(jobId, values.repo)

  if (values.json === true)
    printJson(job === undefined ? { id: jobId, played: true } : { id: job.id, name: job.name, stage: job.stage ?? null, status: job.status, url: job.html_url ?? null })
  else
    console.log(`${role('running', process.stdout)(`started manual job ${job?.name ?? jobId} (${jobId})`)}${job?.html_url === undefined ? '' : `: ${role('path', process.stdout)(job.html_url)}`}`)

  return 0
}
