import type { Run } from '../runs'
import { badge, formatSeconds, jsonOption, limitOf, limitOptions, moreFooter, parse, printJson, table, truncate, upTo } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { resolveCommit } from '../git'
import { runSeconds, runsListing, runsOn, startedAge } from '../runs'

const usage = `ft runs [--sha <ref>]

Lists recent runs with what tea's own listing leaves empty: workflow, ref, duration and age, ten by default with the count of the rest (--full for all of them; --json is never cut unless --limit is given).

Exits 0 when it listed them, 1 when Forgejo or git cannot be read, 2 on a usage error.`

const DEFAULT_LIMIT = 10

const options = {
  limit: { ...limitOptions(DEFAULT_LIMIT).limit, short: 'n' },
  full: limitOptions(DEFAULT_LIMIT).full,
  sha: { type: 'string', short: 's', description: 'only the runs of this commit' },
  workflow: { type: 'string', short: 'w', description: 'only this workflow file, e.g. test.yml' },
  json: jsonOption(),
  ...repoOption,
} as const

const TITLE_WIDTH = 70

async function onCommit(sha: string, repo: string | undefined): Promise<{ runs: Run[], total: number }> {
  const found = await runsOn(await resolveCommit(sha), repo)

  return { runs: found, total: found.length }
}

export async function runs(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values } = parsed
  const limit = limitOf(values, DEFAULT_LIMIT)
  const { runs: found, total } = values.sha === undefined
    ? await runsListing(limit, values.repo, values.workflow)
    : await onCommit(values.sha, values.repo)
  const matching = found.filter(run => values.workflow === undefined || run.workflow_id === values.workflow)
  const list = matching.slice(0, limit)
  const more = values.sha === undefined ? total - list.length : matching.length - list.length

  if (values.json === true) {
    printJson(list.map(run => ({ id: run.id, number: run.index_in_repo, status: run.status, workflow: run.workflow_id, ref: run.prettyref, event: run.event, sha: run.commit_sha, seconds: runSeconds(run), started: run.started, title: run.title, url: run.html_url })))

    return 0
  }

  if (list.length === 0) {
    console.log('no run')

    return 0
  }

  console.log(table([
    ['ID', 'STATUS', 'WORKFLOW', 'REF', 'EVENT', 'TOOK', 'STARTED', 'TITLE'],
    ...list.map(run => [String(run.id), badge(run.status, process.stdout), run.workflow_id, run.prettyref, run.event, run.duration > 0 ? formatSeconds(runSeconds(run)) : '-', startedAge(run), truncate(upTo(run.title, '\n'), TITLE_WIDTH)]),
  ], { header: true }))

  if (more > 0)
    console.log(moreFooter(more))

  return 0
}
