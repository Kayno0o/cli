import type { ExitRow } from '@kaynooo/cli-kit'
import { fail, jsonOption, parse, printJson, role, runHint, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { jobsOf, jsonStatus, pipelineJson, retryJob, retryPipeline } from '../pipelines'

const usage = `gl retry <pipeline id> [-j <job>]

Retries the failed jobs of a pipeline, or with -j one job of it, by name or id.
With -j and no pipeline, the value is a job id.
The pipeline or the job runs again: follow it with gl ci or gl runs.`

const exits: ExitRow[] = [[0, 'it was retried'], [1, 'GitLab refused or cannot be read'], [2, 'a usage error, or a job the pipeline lacks']]

const options = {
  job: { type: 'string', short: 'j', description: 'retry only this job, by name or id' },
  json: jsonOption('the retried pipeline as {id, number, status, ref, sha, url}, or the retried job as {id, name, stage, status, url}'),
  ...repoOption,
} as const

export async function retry(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, { positionals: ['[pipeline]'], exits })
  const [given] = positionals

  if (given === undefined && values.job === undefined)
    fail('a pipeline id or a job is needed', 2, runHint('gl runs', 'list the pipelines'))

  if (values.job === undefined) {
    const pipeline = await retryPipeline(wholeNumber(given ?? '', '<pipeline id>', 0), values.repo)

    if (values.json === true)
      printJson(pipelineJson(pipeline))
    else
      console.log(`${role('running', process.stdout)(`retrying the failed jobs of pipeline ${pipeline.id}`)}: ${role('path', process.stdout)(pipeline.web_url)}`)

    return 0
  }

  let id = Number(values.job)

  if (given !== undefined) {
    const pipeline = wholeNumber(given, '<pipeline id>', 0)
    const jobs = await jobsOf(pipeline, values.repo)
    const found = jobs.find(each => each.name === values.job || String(each.id) === values.job)

    if (found === undefined)
      fail(`pipeline ${pipeline} has no job ${values.job}: ${jobs.map(each => each.name).join(', ')}`)

    id = found.id
  }
  else if (!Number.isInteger(id) || id < 1) {
    fail(`without a pipeline, -j takes a job id, not ${values.job}`, 2, runHint('gl retry <pipeline id> -j <name>', 'retry it by name'))
  }

  const job = await retryJob(id, values.repo)

  if (values.json === true)
    printJson({ id: job.id, name: job.name, stage: job.stage, status: jsonStatus(job.status), url: job.web_url })
  else
    console.log(`${role('running', process.stdout)(`retrying job ${job.name} (${job.id})`)}: ${role('path', process.stdout)(job.web_url)}`)

  return 0
}
