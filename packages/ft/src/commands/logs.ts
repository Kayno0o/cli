import type { Job } from '../runs'
import { badge, fail, jsonOption, paint, parse, printJson, role, runHint, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { excerpt, logLines } from '../log'
import { ciJson, jobLog, jobsOf, runById } from '../runs'

const usage = `ft logs <run id>

Prints what the failed jobs of a run say went wrong: each failed bun test's output and the end of each failed step.
With no failed job it prints every job's last lines; --full prints whole logs.

Exits 0 when it printed the logs, 1 when Forgejo cannot be read, 2 on a usage error or a job the run lacks.`

const options = {
  job: { type: 'string', short: 'j', description: 'only this job, by name or id' },
  full: { type: 'boolean', short: 'f', description: 'the whole log, timestamps stripped' },
  json: jsonOption('status, runs, failedJobs, url and the picked jobs with their log excerpts'),
  ...repoOption,
} as const

export function pickJobs(jobs: Job[], wanted: string | undefined): Job[] {
  if (wanted !== undefined)
    return jobs.filter(job => job.name === wanted || String(job.id) === wanted)

  const failed = jobs.filter(job => job.status === 'failure')

  return failed.length > 0 ? failed : jobs
}

export async function logs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed

  if (positionals[0] === undefined)
    fail('a run id is needed', 2, runHint('ft runs', 'list them'))

  const run = await runById(wholeNumber(positionals[0], '<run id>', 0), values.repo)
  const jobs = await jobsOf(run.id, values.repo)
  const picked = pickJobs(jobs, values.job)

  if (picked.length === 0)
    fail(`run ${run.id} has no job ${values.job ?? ''}: ${jobs.map(job => job.name).join(', ')}`, 2, runHint(`ft logs ${run.id}`, 'read every failed job'))

  const text = async (job: Job) => {
    const log = await jobLog(job.id, values.repo)

    return values.full === true ? logLines(log).join('\n') : excerpt(log)
  }

  if (values.json === true) {
    const shown: { name: string, id: number, status: string, excerpt: string }[] = []

    for (const job of picked)
      shown.push({ name: job.name, id: job.id, status: job.status, excerpt: await text(job) })

    printJson({ ...ciJson([run], shown.filter(job => job.status === 'failure').map(job => ({ name: job.name, run: run.id, workflow: run.workflow_id, excerpt: job.excerpt }))), jobs: shown })

    return 0
  }

  console.log(`${paint(process.stdout).bold(`${run.workflow_id} run ${run.id}`)} on ${run.prettyref} (${run.commit_sha.slice(0, 7)}): ${badge(run.status, process.stdout)}, ${role('path', process.stdout)(run.html_url)}`)

  for (const job of picked) {
    console.log(`\n${paint(process.stdout).bold(`job ${job.name}`)}: ${badge(job.status, process.stdout)}\n${await text(job)}`)
  }

  return 0
}
