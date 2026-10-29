import { formatSeconds, parse, table, truncate, upTo, wholeNumber } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { resolveCommit } from '../git'
import { recentRuns, runSeconds, runsOn, startedAge } from '../runs'

const usage = `ft runs [--sha <ref>]

Lists recent runs with what tea's own listing leaves empty: workflow, ref, duration and age.`

const options = {
  limit: { type: 'string', short: 'n', description: 'how many runs (10)' },
  sha: { type: 'string', short: 's', description: 'only the runs of this commit' },
  workflow: { type: 'string', short: 'w', description: 'only this workflow file, e.g. test.yml' },
  json: { type: 'boolean', description: 'print JSON' },
  ...repoOption,
} as const

const TITLE_WIDTH = 70

export async function runs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const { values } = parsed
  const limit = wholeNumber(values.limit, 'limit', 10)
  const found = values.sha === undefined
    ? await recentRuns(limit, values.repo, values.workflow)
    : await runsOn(await resolveCommit(values.sha), values.repo)
  const list = found.filter(run => values.workflow === undefined || run.workflow_id === values.workflow).slice(0, limit)

  if (values.json === true) {
    console.log(JSON.stringify(list.map(run => ({ id: run.id, number: run.index_in_repo, status: run.status, workflow: run.workflow_id, ref: run.prettyref, event: run.event, sha: run.commit_sha, seconds: runSeconds(run), started: run.started, title: run.title, url: run.html_url })), null, 2))

    return 0
  }

  if (list.length === 0) {
    console.log('no run')

    return 0
  }

  console.log(table([
    ['ID', 'STATUS', 'WORKFLOW', 'REF', 'EVENT', 'TOOK', 'STARTED', 'TITLE'],
    ...list.map(run => [String(run.id), run.status, run.workflow_id, run.prettyref, run.event, run.duration > 0 ? formatSeconds(runSeconds(run)) : '-', startedAge(run), truncate(upTo(run.title, '\n'), TITLE_WIDTH)]),
  ]))

  return 0
}
