import type { Job } from '../pipelines'
import { fail, jsonOption, parse, printJson, runHint, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { ciJson, failedJobs, jobsOf, jobTrace, jsonStatus, pipelineById } from '../pipelines'
import { excerpt, traceLines } from '../trace'

const usage = `gl logs <pipeline id>

Prints what the failed jobs of a pipeline say went wrong: each failed PHPUnit test, else the last lines of the script that failed.
With no failed job it prints every job's last lines; -j picks a job by name or id, --full prints whole traces.

Exits 0 when it printed the logs, 1 when GitLab cannot be read, 2 on a usage error or a job the pipeline lacks.`

const options = {
  job: { type: 'string', short: 'j', description: 'only this job, by name or id' },
  full: { type: 'boolean', short: 'f', description: 'the whole trace, timestamps and colours stripped' },
  json: jsonOption('status, runs, failedJobs, url and the picked jobs with their trace excerpts'),
  ...repoOption,
} as const

function pickJobs(jobs: Job[], wanted: string | undefined): Job[] {
  if (wanted !== undefined)
    return jobs.filter(job => job.name === wanted || String(job.id) === wanted)

  const failed = failedJobs(jobs)

  return failed.length > 0 ? failed : jobs
}

export async function logs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed

  if (positionals[0] === undefined)
    fail('a pipeline id is needed', 2, runHint('gl runs', 'list them'))

  const pipeline = await pipelineById(wholeNumber(positionals[0], '<pipeline id>', 0), values.repo)
  const jobs = await jobsOf(pipeline.id, values.repo)
  const picked = pickJobs(jobs, values.job)

  if (picked.length === 0)
    fail(`pipeline ${pipeline.id} has no job ${values.job ?? ''}: ${jobs.map(job => job.name).join(', ')}`)

  const text = async (job: Job) => {
    const trace = await jobTrace(job.id, values.repo)

    return values.full === true ? traceLines(trace).map(line => line.text).join('\n') : excerpt(trace)
  }

  if (values.json === true) {
    const shown: { name: string, id: number, stage: string, status: string, allowFailure: boolean, url: string, excerpt: string }[] = []

    for (const job of picked)
      shown.push({ name: job.name, id: job.id, stage: job.stage, status: jsonStatus(job.status), allowFailure: job.allow_failure, url: job.web_url, excerpt: await text(job) })

    const failed = shown.filter(job => job.status === 'failure' && !job.allowFailure).map(job => ({ name: job.name, stage: job.stage, reason: null, url: job.url, excerpt: job.excerpt }))

    printJson({ ...ciJson(pipeline, failed), jobs: shown })

    return 0
  }

  console.log(`pipeline ${pipeline.id} on ${pipeline.ref} (${pipeline.sha.slice(0, 7)}): ${pipeline.status}, ${pipeline.web_url}`)

  for (const job of picked)
    console.log(`\njob ${job.name} (${job.stage}): ${job.status}${job.allow_failure && job.status === 'failed' ? ', allowed to fail' : ''}\n${await text(job)}`)

  return 0
}
