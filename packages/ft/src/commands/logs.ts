import type { Job } from '../runs'
import { badge, fail, parse, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { excerpt, logLines } from '../log'
import { jobLog, jobsOf, runById } from '../runs'

const usage = `ft logs <run id>

Prints what the failed jobs of a run say went wrong: each failed bun test's output and the end of each failed step.
With no failed job it prints every job's last lines; --full prints whole logs.`

const options = {
  job: { type: 'string', short: 'j', description: 'only this job, by name' },
  full: { type: 'boolean', short: 'f', description: 'the whole log, timestamps stripped' },
  ...repoOption,
} as const

function pickJobs(jobs: Job[], name: string | undefined): Job[] {
  if (name !== undefined)
    return jobs.filter(job => job.name === name)

  const failed = jobs.filter(job => job.status === 'failure')

  return failed.length > 0 ? failed : jobs
}

export async function logs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed

  if (positionals[0] === undefined)
    fail(`a run id is needed, as \`ft runs\` lists them\n\n${usage}`)

  const run = await runById(wholeNumber(positionals[0], 'run id', 0), values.repo)
  const jobs = await jobsOf(run.id, values.repo)
  const picked = pickJobs(jobs, values.job)

  if (picked.length === 0)
    fail(`run ${run.id} has no job ${values.job ?? ''}: ${jobs.map(job => job.name).join(', ')}`)

  console.log(`${run.workflow_id} run ${run.id} on ${run.prettyref} (${run.commit_sha.slice(0, 7)}): ${badge(run.status, process.stdout)}, ${run.html_url}`)

  for (const job of picked) {
    const log = await jobLog(job.id, values.repo)

    console.log(`\njob ${job.name}: ${badge(job.status, process.stdout)}\n${values.full === true ? logLines(log).join('\n') : excerpt(log)}`)
  }

  return 0
}
